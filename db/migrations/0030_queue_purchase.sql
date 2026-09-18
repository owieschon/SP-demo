-- 0030 Put purchase requests into the one queue.
--
-- The workspace queue (0023) is a view built by inspecting which tables this
-- database actually has, because a view resolves its names when it is created:
-- a branch that does not have the procurement desk gets a queue without it,
-- rather than a view that will not build. 0023 shipped before the procurement
-- desk did, so the view in front of us knows nothing about purchase requests
-- even though 0029 has now created them.
--
-- nl.rebuild_agent_queue() exists for exactly this. Calling it again is the
-- whole migration: it looks at the tables that are here now, writes the view
-- over the sources it finds, and returns what it found.
--
-- This is also why the procurement desk needed no queue code of its own. One
-- queue, one shape, one place a person decides, whatever produced the work.

select nl.rebuild_agent_queue();

do $$
declare
  v_sources jsonb;
begin
  v_sources := nl.agent_queue_sources();
  if not (v_sources ->> 'purchase')::boolean then
    raise exception 'the queue was rebuilt but still has no purchase source: %', v_sources;
  end if;
end $$;
