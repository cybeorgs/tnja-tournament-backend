-- Permanent audit log of student record changes.
CREATE TABLE "StudentAuditLog" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentNo" TEXT,
    "studentName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT '',
    "changes" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudentAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StudentAuditLog_studentId_createdAt_idx" ON "StudentAuditLog"("studentId", "createdAt");
CREATE INDEX "StudentAuditLog_createdAt_idx" ON "StudentAuditLog"("createdAt");

-- Append-only: entries can be added, never changed or removed — by anyone, including the app.
CREATE FUNCTION student_audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'StudentAuditLog is a permanent record: entries cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_audit_log_no_update_delete
    BEFORE UPDATE OR DELETE ON "StudentAuditLog"
    FOR EACH ROW EXECUTE FUNCTION student_audit_log_is_append_only();

CREATE TRIGGER student_audit_log_no_truncate
    BEFORE TRUNCATE ON "StudentAuditLog"
    FOR EACH STATEMENT EXECUTE FUNCTION student_audit_log_is_append_only();

-- The time of each entry always comes from the database clock.
CREATE FUNCTION student_audit_log_stamp() RETURNS trigger AS $$
BEGIN
    NEW."createdAt" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_audit_log_stamp_time
    BEFORE INSERT ON "StudentAuditLog"
    FOR EACH ROW EXECUTE FUNCTION student_audit_log_stamp();
