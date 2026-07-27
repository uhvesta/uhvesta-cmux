import CryptoKit
import Foundation
import SQLite3

/// A review comment left on a line range in the diff viewer.
///
/// `endLine` (on `side`) is the anchor line the comment renders under;
/// `lineText` is that line's content at save time so the comment can be
/// re-anchored when the same diff is regenerated with shifted line numbers.
struct DiffComment: Codable, Equatable, Identifiable {
    var id: UUID
    var filePath: String
    var side: String
    var startLine: Int
    var endLine: Int
    var endSide: String?
    var lineText: String
    var message: String
    /// Formatted text block appended to a TextBox submission when the
    /// workspace's pending pool is consumed.
    var submissionText: String?
    /// Set when a TextBox submission delivered this comment to an agent;
    /// consumed comments never re-enter the pending pool.
    var consumedAt: Date?
    /// The originating review comment when this is a provider-generated answer.
    var parentId: UUID?
    /// Provider-generated answers are displayed but cannot be edited or sent.
    var readOnly: Bool
    /// Optional provider display name for a read-only answer.
    var author: String?
    /// Optional aggregate-review repository label retained with the comment.
    var repositoryLabel: String?
    /// Lifecycle state for a one-turn provider answer, when applicable.
    var requestStatus: String?
    /// Stable one-turn sidecar request identity used to resume an unfinished answer.
    var sidecarRequestID: String?
    /// Agent-chat session identity used to reattach to a live answer stream.
    var sidecarSessionID: String?
    var createdAt: Date
    var updatedAt: Date

    init(
        id: UUID,
        filePath: String,
        side: String,
        startLine: Int,
        endLine: Int,
        endSide: String?,
        lineText: String,
        message: String,
        submissionText: String?,
        consumedAt: Date?,
        parentId: UUID? = nil,
        readOnly: Bool = false,
        author: String? = nil,
        repositoryLabel: String? = nil,
        requestStatus: String? = nil,
        sidecarRequestID: String? = nil,
        sidecarSessionID: String? = nil,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.filePath = filePath
        self.side = side
        self.startLine = startLine
        self.endLine = endLine
        self.endSide = endSide
        self.lineText = lineText
        self.message = message
        self.submissionText = submissionText
        self.consumedAt = consumedAt
        self.parentId = parentId
        self.readOnly = readOnly
        self.author = author
        self.repositoryLabel = repositoryLabel
        self.requestStatus = requestStatus
        self.sidecarRequestID = sidecarRequestID
        self.sidecarSessionID = sidecarSessionID
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, filePath, side, startLine, endLine, endSide, lineText, message
        case submissionText, consumedAt, parentId, readOnly, author, repositoryLabel
        case requestStatus, sidecarRequestID, sidecarSessionID, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(UUID.self, forKey: .id),
            filePath: try container.decode(String.self, forKey: .filePath),
            side: try container.decode(String.self, forKey: .side),
            startLine: try container.decode(Int.self, forKey: .startLine),
            endLine: try container.decode(Int.self, forKey: .endLine),
            endSide: try container.decodeIfPresent(String.self, forKey: .endSide),
            lineText: try container.decode(String.self, forKey: .lineText),
            message: try container.decode(String.self, forKey: .message),
            submissionText: try container.decodeIfPresent(String.self, forKey: .submissionText),
            consumedAt: try container.decodeIfPresent(Date.self, forKey: .consumedAt),
            parentId: try container.decodeIfPresent(UUID.self, forKey: .parentId),
            readOnly: try container.decodeIfPresent(Bool.self, forKey: .readOnly) ?? false,
            author: try container.decodeIfPresent(String.self, forKey: .author),
            repositoryLabel: try container.decodeIfPresent(String.self, forKey: .repositoryLabel),
            requestStatus: try container.decodeIfPresent(String.self, forKey: .requestStatus),
            sidecarRequestID: try container.decodeIfPresent(String.self, forKey: .sidecarRequestID),
            sidecarSessionID: try container.decodeIfPresent(String.self, forKey: .sidecarSessionID),
            createdAt: try container.decode(Date.self, forKey: .createdAt),
            updatedAt: try container.decode(Date.self, forKey: .updatedAt)
        )
    }
}

/// Persists diff viewer review comments in SQLite under
/// `Application Support/cmux/diff-comments/comments.sqlite3`.
///
/// The global instance stores comments created outside a workspace-scoped
/// viewer. `workspaceStore(for:)` returns a view over the same database that
/// isolates comments to one workspace. The database migration imports the
/// previous per-repository JSON files without changing comment identity or
/// line-content re-anchoring data.
@MainActor
final class DiffCommentStore {
    static let shared = DiffCommentStore()

    private struct RepoCommentsFile: Codable {
        var repoRoot: String
        var comments: [DiffComment]
    }

    private enum Scope: Equatable {
        case global
        case workspace(UUID)

        var key: String {
            switch self {
            case .global:
                return "global"
            case .workspace(let id):
                return "workspace:\(id.uuidString.lowercased())"
            }
        }
    }

    private let directoryURL: URL?
    private let scope: Scope
    private var database: OpaquePointer?

    init(directoryURL: URL? = DiffCommentStore.defaultDirectoryURL()) {
        self.directoryURL = directoryURL
        self.scope = .global
        self.database = nil
        openDatabase()
    }

    private init(directoryURL: URL?, scope: Scope) {
        self.directoryURL = directoryURL
        self.scope = scope
        self.database = nil
        openDatabase()
    }

    deinit {
        if let database {
            sqlite3_close_v2(database)
        }
    }

    /// Returns a workspace-scoped view over this store's SQLite database.
    func workspaceStore(for workspaceId: UUID) -> DiffCommentStore {
        DiffCommentStore(directoryURL: directoryURL, scope: .workspace(workspaceId))
    }

    func comments(repoRoot: String) -> [DiffComment] {
        queryComments(repoRoot: repoRoot, scopeKey: scope.key)
    }

    @discardableResult
    func upsert(_ comment: DiffComment, repoRoot: String) -> DiffComment {
        var stored = comment
        if let existingCreatedAt = existingCreatedAt(for: comment.id, scopeKey: scope.key) {
            stored.createdAt = existingCreatedAt
        }
        save(stored, repoRoot: repoRoot, scopeKey: scope.key)
        return stored
    }

    /// Marks comments as delivered to an agent so they never re-enter the
    /// pending submission pool.
    func markConsumed(ids: [UUID], repoRoot: String, at date: Date = Date()) {
        guard !ids.isEmpty else { return }
        let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
        let sql = "UPDATE comments SET consumed_at = ? WHERE scope = ? AND repo_root = ? AND id IN (\(placeholders))"
        var parameters: [SQLiteValue] = [
            .real(date.timeIntervalSince1970),
            .text(scope.key),
            .text(Self.canonicalRepoRoot(repoRoot))
        ]
        parameters.append(contentsOf: ids.map { .text($0.uuidString.lowercased()) })
        execute(sql, parameters: parameters)
    }

    @discardableResult
    func delete(id: UUID, repoRoot: String) -> Bool {
        let sql = "DELETE FROM comments WHERE scope = ? AND (id = ? OR parent_id = ?) AND repo_root = ?"
        let parameters: [SQLiteValue] = [
            .text(scope.key),
            .text(id.uuidString.lowercased()),
            .text(id.uuidString.lowercased()),
            .text(Self.canonicalRepoRoot(repoRoot))
        ]
        guard execute(sql, parameters: parameters) else { return false }
        return database.map { sqlite3_changes($0) > 0 } ?? false
    }

    private enum SQLiteValue {
        case text(String)
        case int(Int32)
        case real(Double)
        case null
    }

    private func openDatabase() {
        let path: String
        if let directoryURL {
            do {
                try FileManager.default.createDirectory(
                    at: directoryURL,
                    withIntermediateDirectories: true
                )
            } catch {
                logStoreError("createDirectory", error)
                return
            }
            path = directoryURL.appendingPathComponent("comments.sqlite3").path
        } else {
            path = ":memory:"
        }

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close_v2(handle) }
            return
        }
        database = handle
        guard execute("PRAGMA journal_mode = WAL;"),
              execute("""
                CREATE TABLE IF NOT EXISTS comments (
                    id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    repo_root TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    side TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    end_side TEXT,
                    line_text TEXT NOT NULL,
                    message TEXT NOT NULL,
                    submission_text TEXT,
                    consumed_at REAL,
                    parent_id TEXT,
                    read_only INTEGER NOT NULL DEFAULT 0,
                    author TEXT,
                    repository_label TEXT,
                    request_status TEXT,
                    sidecar_request_id TEXT,
                    sidecar_session_id TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (scope, id)
                );
                """),
              execute("CREATE INDEX IF NOT EXISTS comments_scope_repo ON comments(scope, repo_root);") else {
            return
        }
        migrateSchemaIfNeeded()
        migrateLegacyJSONIfNeeded()
        _ = execute("PRAGMA user_version = 4;")
    }

    private func migrateSchemaIfNeeded() {
        addColumnIfNeeded(name: "parent_id", definition: "TEXT")
        addColumnIfNeeded(name: "read_only", definition: "INTEGER NOT NULL DEFAULT 0")
        addColumnIfNeeded(name: "author", definition: "TEXT")
        addColumnIfNeeded(name: "repository_label", definition: "TEXT")
        addColumnIfNeeded(name: "request_status", definition: "TEXT")
        addColumnIfNeeded(name: "sidecar_request_id", definition: "TEXT")
        addColumnIfNeeded(name: "sidecar_session_id", definition: "TEXT")
        migrateScopePrimaryKeyIfNeeded()
        _ = execute("CREATE INDEX IF NOT EXISTS comments_scope_repo ON comments(scope, repo_root);")
        _ = execute("CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id);")
    }

    /// Upgrades the original `id`-only key to a scope-qualified identity.
    /// The original schema could overwrite a global comment with the same UUID
    /// from a workspace store. Rebuilding is the only SQLite-supported way to
    /// change a primary key, and copies every persisted column verbatim.
    private func migrateScopePrimaryKeyIfNeeded() {
        let primaryKeyColumns = query("PRAGMA table_info(comments);", parameters: []) { statement -> (Int32, String)? in
            let order = sqlite3_column_int(statement, 5)
            guard order > 0, let name = self.sqliteText(statement, 1) else { return nil }
            return (order, name)
        }
        .sorted { $0.0 < $1.0 }
        .map(\.1)
        guard primaryKeyColumns != ["scope", "id"] else { return }

        guard execute("BEGIN IMMEDIATE TRANSACTION;") else { return }
        let migrated = execute("""
            CREATE TABLE comments_scope_migration (
                id TEXT NOT NULL,
                scope TEXT NOT NULL,
                repo_root TEXT NOT NULL,
                file_path TEXT NOT NULL,
                side TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                end_side TEXT,
                line_text TEXT NOT NULL,
                message TEXT NOT NULL,
                submission_text TEXT,
                consumed_at REAL,
                parent_id TEXT,
                read_only INTEGER NOT NULL DEFAULT 0,
                author TEXT,
                repository_label TEXT,
                request_status TEXT,
                sidecar_request_id TEXT,
                sidecar_session_id TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (scope, id)
            );
            """) && execute("""
                INSERT INTO comments_scope_migration(
                    id, scope, repo_root, file_path, side, start_line, end_line,
                    end_side, line_text, message, submission_text, consumed_at,
                    parent_id, read_only, author, repository_label, request_status,
                    sidecar_request_id, sidecar_session_id,
                    created_at, updated_at
                ) SELECT
                    id, scope, repo_root, file_path, side, start_line, end_line,
                    end_side, line_text, message, submission_text, consumed_at,
                    parent_id, read_only, author, repository_label, request_status,
                    sidecar_request_id, sidecar_session_id,
                    created_at, updated_at
                FROM comments;
                """) && execute("DROP TABLE comments;") && execute("ALTER TABLE comments_scope_migration RENAME TO comments;")

        _ = execute(migrated ? "COMMIT;" : "ROLLBACK;")
    }

    private func addColumnIfNeeded(name: String, definition: String) {
        guard !tableColumns(named: "comments").contains(name) else { return }
        _ = execute("ALTER TABLE comments ADD COLUMN \(name) \(definition);")
    }

    private func tableColumns(named table: String) -> Set<String> {
        query("PRAGMA table_info(\(table));", parameters: []) { statement in
            self.sqliteText(statement, 1)
        }
        .reduce(into: Set<String>()) { $0.insert($1) }
    }

    private func migrateLegacyJSONIfNeeded() {
        guard let database,
              migrationVersion(database) == 0,
              let directoryURL,
              let files = try? FileManager.default.contentsOfDirectory(
                  at: directoryURL,
                  includingPropertiesForKeys: nil
              ) else {
            return
        }
        for fileURL in files where fileURL.pathExtension.lowercased() == "json" {
            guard let data = try? Data(contentsOf: fileURL),
                  let file = try? Self.decoder().decode(RepoCommentsFile.self, from: data) else {
                continue
            }
            for comment in file.comments {
                var stored = comment
                if let existingCreatedAt = existingCreatedAt(for: comment.id, scopeKey: Scope.global.key) {
                    stored.createdAt = existingCreatedAt
                }
                save(
                    stored,
                    repoRoot: file.repoRoot,
                    scopeKey: Scope.global.key
                )
            }
        }
        _ = execute("PRAGMA user_version = 1;")
    }

    private func migrationVersion(_ database: OpaquePointer) -> Int32 {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, "PRAGMA user_version;", -1, &statement, nil) == SQLITE_OK else {
            return 1
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return 1 }
        return sqlite3_column_int(statement, 0)
    }

    private func queryComments(repoRoot: String, scopeKey: String) -> [DiffComment] {
        let sql = """
            SELECT id, file_path, side, start_line, end_line, end_side,
                   line_text, message, submission_text, consumed_at,
                   parent_id, read_only, author, repository_label, request_status,
                   sidecar_request_id, sidecar_session_id,
                   created_at, updated_at
            FROM comments
            WHERE scope = ? AND repo_root = ?
            ORDER BY created_at ASC, id ASC;
            """
        return query(sql, parameters: [
            .text(scopeKey),
            .text(Self.canonicalRepoRoot(repoRoot))
        ]) { statement in
            guard let idString = sqliteText(statement, 0),
                  let id = UUID(uuidString: idString),
                  let filePath = sqliteText(statement, 1),
                  let side = sqliteText(statement, 2),
                  let lineText = sqliteText(statement, 6),
                  let message = sqliteText(statement, 7) else {
                return nil
            }
            return DiffComment(
                id: id,
                filePath: filePath,
                side: side,
                startLine: Int(sqlite3_column_int(statement, 3)),
                endLine: Int(sqlite3_column_int(statement, 4)),
                endSide: sqliteText(statement, 5),
                lineText: lineText,
                message: message,
                submissionText: sqliteText(statement, 8),
                consumedAt: sqlite3_column_type(statement, 9) == SQLITE_NULL ? nil : Date(timeIntervalSince1970: sqlite3_column_double(statement, 9)),
                parentId: sqliteText(statement, 10).flatMap(UUID.init(uuidString:)),
                readOnly: sqlite3_column_int(statement, 11) != 0,
                author: sqliteText(statement, 12),
                repositoryLabel: sqliteText(statement, 13),
                requestStatus: sqliteText(statement, 14),
                sidecarRequestID: sqliteText(statement, 15),
                sidecarSessionID: sqliteText(statement, 16),
                createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 17)),
                updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 18))
            )
        }
    }

    private func existingCreatedAt(for id: UUID, scopeKey: String) -> Date? {
        query(
            "SELECT created_at FROM comments WHERE scope = ? AND id = ? LIMIT 1;",
            parameters: [.text(scopeKey), .text(id.uuidString.lowercased())]
        ) { statement in
            Date(timeIntervalSince1970: sqlite3_column_double(statement, 0))
        }.first
    }

    private func save(_ comment: DiffComment, repoRoot: String, scopeKey: String) {
        let sql = """
            INSERT INTO comments(
                id, scope, repo_root, file_path, side, start_line, end_line,
                end_side, line_text, message, submission_text, consumed_at,
                parent_id, read_only, author, repository_label, request_status,
                sidecar_request_id, sidecar_session_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, id) DO UPDATE SET
                repo_root = excluded.repo_root,
                file_path = excluded.file_path,
                side = excluded.side,
                start_line = excluded.start_line,
                end_line = excluded.end_line,
                end_side = excluded.end_side,
                line_text = excluded.line_text,
                message = excluded.message,
                submission_text = excluded.submission_text,
                consumed_at = excluded.consumed_at,
                parent_id = excluded.parent_id,
                read_only = excluded.read_only,
                author = excluded.author,
                repository_label = excluded.repository_label,
                request_status = excluded.request_status,
                sidecar_request_id = excluded.sidecar_request_id,
                sidecar_session_id = excluded.sidecar_session_id,
                updated_at = excluded.updated_at;
            """
        _ = execute(sql, parameters: [
            .text(comment.id.uuidString.lowercased()),
            .text(scopeKey),
            .text(Self.canonicalRepoRoot(repoRoot)),
            .text(comment.filePath),
            .text(comment.side),
            .int(Int32(comment.startLine)),
            .int(Int32(comment.endLine)),
            comment.endSide.map(SQLiteValue.text) ?? .null,
            .text(comment.lineText),
            .text(comment.message),
            comment.submissionText.map(SQLiteValue.text) ?? .null,
            comment.consumedAt.map { .real($0.timeIntervalSince1970) } ?? .null,
            comment.parentId.map { .text($0.uuidString.lowercased()) } ?? .null,
            .int(comment.readOnly ? 1 : 0),
            comment.author.map(SQLiteValue.text) ?? .null,
            comment.repositoryLabel.map(SQLiteValue.text) ?? .null,
            comment.requestStatus.map(SQLiteValue.text) ?? .null,
            comment.sidecarRequestID.map(SQLiteValue.text) ?? .null,
            comment.sidecarSessionID.map(SQLiteValue.text) ?? .null,
            .real(comment.createdAt.timeIntervalSince1970),
            .real(comment.updatedAt.timeIntervalSince1970)
        ])
    }

    @discardableResult
    private func execute(_ sql: String, parameters: [SQLiteValue] = []) -> Bool {
        guard let database else { return false }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            logSQLiteError("prepare")
            return false
        }
        defer { sqlite3_finalize(statement) }
        guard bind(parameters, to: statement) else { return false }
        let result = sqlite3_step(statement)
        guard result == SQLITE_DONE || result == SQLITE_ROW else {
            logSQLiteError("step")
            return false
        }
        return true
    }

    private func query<Result>(_ sql: String, parameters: [SQLiteValue], _ decode: (OpaquePointer) -> Result?) -> [Result] {
        guard let database else { return [] }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            logSQLiteError("prepare")
            return []
        }
        defer { sqlite3_finalize(statement) }
        guard bind(parameters, to: statement) else { return [] }
        var results: [Result] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let result = decode(statement!) {
                results.append(result)
            }
        }
        return results
    }

    private func bind(_ parameters: [SQLiteValue], to statement: OpaquePointer?) -> Bool {
        for (index, parameter) in parameters.enumerated() {
            let position = Int32(index + 1)
            let result: Int32
            switch parameter {
            case .text(let value):
                result = value.withCString { pointer in
                    sqlite3_bind_text(statement, position, pointer, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                }
            case .int(let value):
                result = sqlite3_bind_int(statement, position, value)
            case .real(let value):
                result = sqlite3_bind_double(statement, position, value)
            case .null:
                result = sqlite3_bind_null(statement, position)
            }
            guard result == SQLITE_OK else {
                logSQLiteError("bind")
                return false
            }
        }
        return true
    }

    private func sqliteText(_ statement: OpaquePointer, _ column: Int32) -> String? {
        guard let value = sqlite3_column_text(statement, column) else { return nil }
        return String(cString: value)
    }

    private func logSQLiteError(_ operation: String) {
        let message: String
        if let database, let error = sqlite3_errmsg(database) {
            message = String(cString: error)
        } else {
            message = "unknown"
        }
        logStoreError(operation, NSError(domain: "DiffCommentStore.SQLite", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
    }

    private func logStoreError(_ operation: String, _ error: Error) {
#if DEBUG
        cmuxDebugLog("diffComments.store.\(operation)Failed error=\(error.localizedDescription)")
#endif
    }

    nonisolated static func canonicalRepoRoot(_ raw: String) -> String {
        if raw.lowercased().hasPrefix("ssh://") {
            return raw.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        return URL(fileURLWithPath: raw).standardizedFileURL.resolvingSymlinksInPath().path
    }

    nonisolated static func repoKey(forRepoRoot repoRoot: String) -> String {
        let canonical = canonicalRepoRoot(repoRoot)
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(24).lowercased()
    }

    nonisolated static func defaultDirectoryURL(
        appSupportDirectory: URL? = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first,
        isRunningUnderAutomatedTests: Bool = SessionRestorePolicy.isRunningUnderAutomatedTests()
    ) -> URL? {
        guard !isRunningUnderAutomatedTests, let appSupportDirectory else { return nil }
        return appSupportDirectory
            .appendingPathComponent("cmux", isDirectory: true)
            .appendingPathComponent("diff-comments", isDirectory: true)
    }

    nonisolated static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }

    nonisolated static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
