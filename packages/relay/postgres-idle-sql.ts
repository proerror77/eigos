/** These SECURITY INVOKER functions are installed by the offline importer and
 * verified byte-for-byte by the runtime grant tool. One call is one Hyperdrive
 * statement; locks are released before the HTTP request starts waiting. */
export const relayIdleIngressSql = `
CREATE FUNCTION relay_idle_ingress(subject_key TEXT, requested_ms BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  started TIMESTAMPTZ := clock_timestamp(); current_ms BIGINT; bucket_id BIGINT; seen BIGINT;
BEGIN
  LOCK TABLE relay_agents IN EXCLUSIVE MODE;
  current_ms := GREATEST(requested_ms + CEIL(EXTRACT(EPOCH FROM (clock_timestamp()-started))*1000)::BIGINT,
    FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT);
  bucket_id := current_ms / 60000;
  DELETE FROM relay_limits WHERE bucket < bucket_id-2;
  SELECT count INTO seen FROM relay_limits WHERE subject=subject_key AND bucket=bucket_id;
  IF seen IS NULL AND (SELECT count(*) FROM relay_limits WHERE bucket=bucket_id AND subject LIKE 'ingress:%') >= 2048 THEN
    RETURN jsonb_build_object('error','RATE_LIMITED','status',429);
  END IF;
  IF COALESCE(seen,0) >= 600 THEN RETURN jsonb_build_object('error','RATE_LIMITED','status',429); END IF;
  INSERT INTO relay_limits VALUES(subject_key,bucket_id,1)
    ON CONFLICT(subject,bucket) DO UPDATE SET count=relay_limits.count+1;
  RETURN '{}'::jsonb;
END;
$$;
`;

export const relayIdlePollSql = `
CREATE FUNCTION relay_idle_poll(input JSONB, requested_ms BIGINT, max_message_ms BIGINT, retention_ms BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  started TIMESTAMPTZ := clock_timestamp(); current_ms BIGINT; bucket_id BIGINT;
  actor TEXT := input->>'actor'; lease_id TEXT := input->>'lease';
  finished BOOLEAN := (input->>'finished')::BOOLEAN; row_agent relay_agents%ROWTYPE;
  seen BIGINT; inserted BIGINT; own_polls BIGINT; total_polls BIGINT; items JSONB;
BEGIN
  LOCK TABLE relay_agents IN EXCLUSIVE MODE;
  current_ms := GREATEST(requested_ms + CEIL(EXTRACT(EPOCH FROM (clock_timestamp()-started))*1000)::BIGINT,
    FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT);
  IF finished THEN
    DELETE FROM relay_poll_leases WHERE id=lease_id AND agent_id=actor;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted<>1 THEN RETURN jsonb_build_object('error','RELAY_UNAVAILABLE','status',503); END IF;
  END IF;
  SELECT * INTO row_agent FROM relay_agents WHERE id=actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','AGENT_NOT_FOUND','status',404); END IF;
  IF row_agent.state<>'active' OR row_agent.expires_at<=current_ms THEN
    RETURN jsonb_build_object('error','AGENT_REVOKED_OR_EXPIRED','status',401);
  END IF;
  IF NOT finished THEN
    IF (input->>'proofExpiry')::BIGINT<=current_ms THEN RETURN jsonb_build_object('error','INVALID_DPOP_PROOF','status',401); END IF;
    DELETE FROM relay_proofs WHERE expires_at<current_ms;
    INSERT INTO relay_proofs VALUES(actor,input->>'proofId',(input->>'proofExpiry')::BIGINT) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted<>1 THEN RETURN jsonb_build_object('error','DPOP_PROOF_REPLAY','status',401); END IF;
    bucket_id := current_ms / 60000;
    DELETE FROM relay_limits WHERE bucket<bucket_id-2;
    SELECT count INTO seen FROM relay_limits WHERE subject='node:'||actor AND bucket=bucket_id;
    IF COALESCE(seen,0)>=(input->>'rateLimit')::BIGINT THEN RETURN jsonb_build_object('error','RATE_LIMITED','status',429); END IF;
    INSERT INTO relay_limits VALUES('node:'||actor,bucket_id,1)
      ON CONFLICT(subject,bucket) DO UPDATE SET count=relay_limits.count+1;
    -- Authentication, proof consumption and node rate precede query errors,
    -- matching the ordinary HTTP path and preventing malformed-query replay.
    IF COALESCE((input->>'invalidQuery')::BOOLEAN,false) THEN RETURN jsonb_build_object('error','INVALID_INPUT','status',400); END IF;
    DELETE FROM relay_poll_leases WHERE expires_at<=current_ms;
    SELECT count(*),count(*) FILTER(WHERE agent_id=actor) INTO total_polls,own_polls FROM relay_poll_leases;
    IF own_polls>=2 OR total_polls>=100 THEN RETURN jsonb_build_object('error','POLL_LIMIT','status',429); END IF;
    INSERT INTO relay_poll_leases VALUES(lease_id,actor,current_ms+120000);
  END IF;
  PERFORM relay_cleanup(current_ms,max_message_ms,retention_ms);
  -- Include time spent before function entry and during cleanup. The actor
  -- cannot be concurrently changed while this shared table lock is held.
  current_ms := GREATEST(requested_ms + CEIL(EXTRACT(EPOCH FROM (clock_timestamp()-started))*1000)::BIGINT,
    FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT);
  IF row_agent.expires_at<=current_ms THEN
    DELETE FROM relay_poll_leases WHERE id=lease_id AND agent_id=actor;
    RETURN jsonb_build_object('error','AGENT_REVOKED_OR_EXPIRED','status',401);
  END IF;
  SELECT COALESCE(jsonb_agg(item ORDER BY seq),'[]'::jsonb) INTO items FROM (
    SELECT m.seq,jsonb_build_object('receipt',jsonb_build_object('id',m.id,'senderId',m.sender,'recipientId',m.recipient,
      'digest',m.digest,'status',m.state,'expiresAt',m.expires_at),'signedEnvelope',m.envelope,'signedSenderCard',a.signed_card) AS item
    FROM relay_messages m JOIN relay_agents a ON a.id=m.sender JOIN relay_connections c ON c.id=m.connection_id
    WHERE m.recipient=actor AND m.state='queued' AND m.expires_at>current_ms AND c.state='accepted' AND a.state='active' AND a.expires_at>current_ms
    ORDER BY m.seq LIMIT (input->>'limit')::INTEGER
  ) pending;
  RETURN jsonb_build_object('lease',lease_id,'items',items,'actorExpiresAt',row_agent.expires_at);
END;
$$;
`;

export const relayIdleFunctions = [
  { name: 'relay_idle_ingress', arguments: 'text,bigint', count: 2, sql: relayIdleIngressSql },
  { name: 'relay_idle_poll', arguments: 'jsonb,bigint,bigint,bigint', count: 4, sql: relayIdlePollSql },
] as const;
