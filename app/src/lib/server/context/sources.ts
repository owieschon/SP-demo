// Adapters over the stores that already exist.
//
// The rule this file follows: an ERP snapshot row, a mail message, an
// archived letter, an attachment and a hand entry are all "source
// documents", and a source document POINTS BACK at the row it really lives
// in. Nothing is copied. That is what makes a citation a link into the real
// record rather than a second copy that can go stale.
//
// Each adapter is one function: find what this store holds that is not
// registered yet, and register it. They are deliberately small and separate,
// because a real deployment would replace one of them with a connector and
// leave the others alone.
import type { Tx } from '../db/types.ts';

export interface AdapterResult {
	source: string;
	registered: number;
	/** Documents this store holds that were already registered. */
	known: number;
}

/**
 * One store, described once: which source it belongs to, the table, and the
 * SQL that turns a row into the columns nl.register_source_document wants.
 * The `available` check is a to_regclass, so a database without the mail
 * feature or without the ERP snapshots registers the rest and says nothing
 * about the one it does not have.
 */
interface Adapter {
	source: string;
	table: string;
	/** external_ref, title, received_at, media_type, ref_table, ref_id. */
	rows: string;
}

const ADAPTERS: Adapter[] = [
	{
		// The order desk's live inbox. The desk agent owns this table; the
		// context engine only reads it.
		source: 'order_desk_inbox',
		table: 'mail_messages',
		rows: `
			select 'message-' || m.id as external_ref,
			       left(coalesce(nullif(m.subject, ''), 'A message with no subject'), 300) as title,
			       m.received_at,
			       'text/plain' as media_type,
			       'mail_messages' as ref_table,
			       m.id::text as ref_id
			from nl.mail_messages m`
	},
	{
		source: 'mail_archive',
		table: 'mail_archive',
		rows: `
			select 'archive-' || a.id as external_ref,
			       left(coalesce(nullif(a.subject, ''), 'An archived message with no subject'), 300) as title,
			       a.received_at,
			       'text/plain' as media_type,
			       'mail_archive' as ref_table,
			       a.id::text as ref_id
			from nl.mail_archive a`
	},
	{
		// Notes and calls the team logged. A note is a hand entry that happens
		// to live in the CRM, and it is worth mining for exactly that reason.
		source: 'crm_activity',
		table: 'activities',
		rows: `
			select 'activity-' || v.id as external_ref,
			       left(v.kind || ' with ' || v.customer_no, 300) as title,
			       v.occurred_at as received_at,
			       'text/plain' as media_type,
			       'activities' as ref_table,
			       v.id::text as ref_id
			from nl.activities v
			where length(v.body) > 30`
	},
	{
		source: 'hand_entry',
		table: 'context_entries',
		rows: `
			select 'entry-' || e.id as external_ref,
			       left('Hand entry about ' || e.subject_kind || ' ' || e.subject_id, 300) as title,
			       e.entered_at as received_at,
			       'text/plain' as media_type,
			       'context_entries' as ref_table,
			       e.id::text as ref_id
			from nl.context_entries e`
	},
	{
		source: 'legacy_crm_2024',
		table: 'legacy_crm_rows',
		rows: `
			select 'legacy-row-' || r.row_no as external_ref,
			       left('CRM export row ' || r.row_no, 300) as title,
			       r.imported_at as received_at,
			       'text/csv' as media_type,
			       'legacy_crm_rows' as ref_table,
			       r.id::text as ref_id
			from nl.legacy_crm_rows r`
	},
	{
		// The ERP's own export. The rows are the staged snapshot lines, which
		// are already hashed and dated by migration 0010.
		source: 'erp_open_orders',
		table: 'export_snapshot_lines',
		rows: `
			select 'snapshot-' || l.snapshot_id || '-row-' || l.row_no as external_ref,
			       left('Open sales line ' || l.document_no || '/' || l.line_no, 300) as title,
			       s.staged_at as received_at,
			       'text/csv' as media_type,
			       'export_snapshot_lines' as ref_table,
			       l.snapshot_id || ':' || l.document_no || ':' || l.line_no as ref_id
			from nl.export_snapshot_lines l
			join nl.export_snapshots s on s.id = l.snapshot_id
			where s.is_current`
	}
];

/**
 * Register whatever each store holds that the context engine has not seen.
 * Idempotent: nl.register_source_document is an upsert on
 * (source, external_ref), so running this every night costs one statement per
 * store and writes nothing new when nothing arrived.
 *
 * `limit` caps each store, because the first run over a full world would
 * otherwise register every activity in three years in one transaction.
 */
export async function registerSources(tx: Tx, options: { limit?: number } = {}): Promise<AdapterResult[]> {
	const limit = options.limit ?? 500;
	const results: AdapterResult[] = [];

	for (const adapter of ADAPTERS) {
		const [present] = await tx.query<{ there: boolean; source: boolean }>(
			`select pg_catalog.to_regclass('nl.' || $1) is not null as there,
			        exists (select 1 from nl.sources where key = $2) as source`,
			[adapter.table, adapter.source]
		);
		// A store this database does not have, or a source nobody registered.
		// Neither is an error: the engine works with what is here.
		if (!present?.there || !present.source) continue;

		const [before] = await tx.query<{ n: number }>(
			'select count(*)::int as n from nl.source_documents where source_key = $1',
			[adapter.source]
		);
		await tx.query(
			`select nl.register_source_document($1, r.external_ref, r.title, r.received_at,
			                                    r.media_type, null, r.ref_table, r.ref_id)
			 from (${adapter.rows} order by received_at desc limit $2) r`,
			[adapter.source, limit]
		);
		const [after] = await tx.query<{ n: number }>(
			'select count(*)::int as n from nl.source_documents where source_key = $1',
			[adapter.source]
		);
		results.push({
			source: adapter.source,
			registered: after.n - before.n,
			known: before.n
		});
	}

	return results;
}

export interface SourceDocumentRow {
	id: number;
	source_key: string;
	source_name: string;
	trust_tier: number;
	external_ref: string;
	title: string;
	received_at: Date;
	ref_table: string;
	ref_id: string;
	text: string | null;
	/** The account or supplier the store itself names, when it names one. */
	customer_no: string | null;
	vendor_no: string | null;
	from_address: string | null;
}

/**
 * The documents worth searching for evidence about one subject, newest first.
 *
 * "Worth searching" is deliberately generous: anything the store itself ties
 * to this account, plus anything from its email domain, plus its activity
 * notes and its legacy rows. Being generous here is cheap, because the span
 * guard and the dictionary decide what actually becomes a claim.
 */
export async function documentsAbout(
	tx: Tx,
	subject: { kind: string; id: string },
	options: { limit?: number } = {}
): Promise<SourceDocumentRow[]> {
	const limit = options.limit ?? 40;
	return tx.query<SourceDocumentRow>(
		`with subject as (
		   select $1::text as kind, $2::text as id
		 ),
		 account as (
		   select c.customer_no, lower(coalesce(c.email_domain, '')) as domain
		   from nl.customers c, subject s
		   where s.kind = 'customer' and c.customer_no = s.id
		 )
		 select d.id, d.source_key, s.name as source_name, s.trust_tier, d.external_ref, d.title,
		        d.received_at, d.ref_table, d.ref_id,
		        nl.source_document_text(d.id) as text,
		        m.customer_no, m.vendor_no, m.from_address
		 from nl.source_documents d
		 join nl.sources s on s.key = d.source_key
		 left join lateral (
		   select a.customer_no, a.vendor_no, a.from_address
		   from nl.mail_archive a
		   where d.ref_table = 'mail_archive' and a.id::text = d.ref_id
		   union all
		   select mm.customer_no, mm.vendor_no, mm.from_address
		   from nl.mail_messages mm
		   where d.ref_table = 'mail_messages' and mm.id::text = d.ref_id
		   union all
		   select av.customer_no, null, null
		   from nl.activities av
		   where d.ref_table = 'activities' and av.id::text = d.ref_id
		   union all
		   select case when e.subject_kind = 'customer' then e.subject_id end,
		          case when e.subject_kind = 'vendor' then e.subject_id end, null
		   from nl.context_entries e
		   where d.ref_table = 'context_entries' and e.id::text = d.ref_id
		   limit 1
		 ) m on true
		 where s.active
		   and (
		     -- the store names the subject outright
		     (m.customer_no is not null and m.customer_no = (select id from subject)
		        and (select kind from subject) = 'customer')
		     or (m.vendor_no is not null and m.vendor_no = (select id from subject)
		        and (select kind from subject) = 'vendor')
		     -- or the sender is on the account's email domain
		     or (m.from_address is not null
		         and exists (select 1 from account a
		                     where a.domain <> '' and lower(m.from_address) like '%@' || a.domain))
		     -- or it is a legacy row that names the account number
		     or (d.ref_table = 'legacy_crm_rows'
		         and exists (select 1 from nl.legacy_crm_rows r, subject sb
		                     where r.id::text = d.ref_id and sb.kind = 'customer'
		                       and r.raw ->> 'acct_no' = sb.id))
		   )
		 order by d.received_at desc, d.id desc
		 limit $3`,
		[subject.kind, subject.id, limit]
	);
}
