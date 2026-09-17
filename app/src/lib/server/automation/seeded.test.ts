// The example rules in db/seed.d/30_automation_rules.sql must be rules the
// app itself would accept, and each must run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { ruleSchema } from '$lib/automation/catalog';
import { runRule, testRule } from './rules.ts';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

interface SeededRule {
	id: number;
	owner_id: number;
	name: string;
	description: string;
	trigger: string;
	conditions: unknown;
	action: unknown;
	enabled: boolean;
}

describe('the example rules in the world', () => {
	it('exist, pass the catalog check, test and run', async () => {
		const rules = await db.asSystem((tx) =>
			tx.sql<SeededRule>`select id, owner_id, name, description, trigger, conditions, action, enabled
			                   from nl.automation_rules order by id`
		);
		expect(rules.length).toBe(4);
		for (const rule of rules) {
			const parsed = ruleSchema.safeParse(rule);
			expect(parsed.success, `${rule.name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
			if (!parsed.success) continue;
			await testRule(db, rule.owner_id, parsed.data, rule.id);
			if (rule.enabled) {
				const result = await runRule(db, rule.owner_id, rule.id, 'ui');
				expect(result).toBeTruthy();
			}
		}
	});
});
