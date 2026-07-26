-- Allow Editor presentation artifacts alongside leaf/reduce/synth.
alter table node_artifacts drop constraint if exists node_artifacts_kind_check;
alter table node_artifacts add constraint node_artifacts_kind_check
  check (kind in ('leaf', 'reduce', 'synth', 'formatted'));
