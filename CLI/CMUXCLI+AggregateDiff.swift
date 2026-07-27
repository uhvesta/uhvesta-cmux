import Foundation

extension CMUXCLI {
    /// One leaf repository in an aggregate review payload.
    struct DiffReviewRepositoryManifest: Codable, Equatable {
        var id: String
        var root: String
        var label: String
        var baseRef: String?
        var patch: String
    }

    /// The versioned, stdio-safe representation shared by local and SSH review sources.
    struct DiffReviewAggregateManifest: Codable, Equatable {
        static let schemaVersion = 1

        var schemaVersion: Int
        var root: String
        var source: String
        var repositories: [DiffReviewRepositoryManifest]

        var jsonObject: [String: Any] {
            guard let data = try? JSONEncoder().encode(self),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return [:]
            }
            return object
        }
    }

    struct DiffRemoteReviewTarget: Equatable {
        var destination: String
        var root: String
        var companionExecutable: String
    }

    /// Finds sibling repositories under a review root. A repository is a leaf
    /// for discovery purposes: nested repositories are deliberately not traversed.
    func discoverReviewRepositories(at root: String) -> [String] {
        let fileManager = FileManager.default
        let rootURL = URL(fileURLWithPath: root).standardizedFileURL
        var repositories: [String] = []

        func isRepository(_ url: URL) -> Bool {
            let result = CLIProcessRunner.runProcess(
                executablePath: "/usr/bin/env",
                arguments: ["git", "-C", url.path, "rev-parse", "--show-toplevel"],
                timeout: 10
            )
            return !result.timedOut && result.status == 0
        }

        func visit(_ url: URL) {
            if isRepository(url) {
                repositories.append(url.path)
                return
            }
            guard let entries = try? fileManager.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            ) else { return }
            for entry in entries.sorted(by: { $0.path.localizedCaseInsensitiveCompare($1.path) == .orderedAscending }) {
                guard (try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])).map({ $0.isDirectory == true && $0.isSymbolicLink != true }) == true else {
                    continue
                }
                visit(entry)
            }
        }

        visit(rootURL)
        return repositories
    }

    func aggregateDiffInput(root: String, source: DiffSource, baseRef: String?) throws -> DiffInput {
        let manifest = try aggregateDiffManifest(root: root, source: source, baseRef: baseRef)
        let patch = manifest.repositories
            .map(\.patch)
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return DiffInput(
            patch: patch,
            sourceLabel: "aggregate git \(source.slug)",
            defaultTitle: "Aggregate review",
            emptyMessage: manifest.repositories.isEmpty
                ? "No Git repositories found under this path."
                : "No changes found in the discovered repositories.",
            externalURL: nil,
            aggregateManifest: manifest
        )
    }

    func aggregateDiffManifest(root: String, source: DiffSource, baseRef: String?) throws -> DiffReviewAggregateManifest {
        let rootURL = URL(fileURLWithPath: root).standardizedFileURL
        let repositories = discoverReviewRepositories(at: rootURL.path)
        var entries: [DiffReviewRepositoryManifest] = []

        for repository in repositories {
            let identifier = aggregateRepositoryIdentifier(repository, root: rootURL.path)
            var arguments = [
                "diff", "--no-ext-diff", "--no-color", "--binary", Self.gitFullFileContextArgument,
                "--src-prefix=a/\(identifier)/", "--dst-prefix=b/\(identifier)/",
            ]
            var resolvedBaseRef: String?
            switch source {
            case .unstaged:
                arguments.append(contentsOf: ["--"])
            case .staged:
                arguments.append(contentsOf: ["--cached", "--"])
            case .branch:
                let base = try resolvedGitBranchDiffBaseRef(baseRef, in: repository)
                let mergeBase = try gitAggregateSingleLine(["merge-base", "HEAD", base], in: repository)
                resolvedBaseRef = base
                arguments.append(contentsOf: [mergeBase, "--"])
            case .lastTurn:
                throw CLIError(message: "Aggregate review does not support last-turn source")
            }
            let result = CLIProcessRunner.runProcess(
                executablePath: "/usr/bin/env",
                arguments: ["git", "-C", repository] + arguments,
                timeout: 120
            )
            guard !result.timedOut, result.status == 0 else { continue }
            let patch = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            entries.append(
                DiffReviewRepositoryManifest(
                    id: identifier,
                    root: repository,
                    label: identifier,
                    baseRef: resolvedBaseRef,
                    patch: patch
                )
            )
        }

        return DiffReviewAggregateManifest(
            schemaVersion: DiffReviewAggregateManifest.schemaVersion,
            root: rootURL.path,
            source: source.slug,
            repositories: entries
        )
    }

    /// Parses an SSH review target in `host:/absolute/path` form, or a host plus
    /// explicit `--remote-path`. The companion has no listener: ssh owns its stdio.
    func remoteReviewTarget(
        destination rawDestination: String,
        remotePath: String?,
        companionExecutable: String?
    ) throws -> DiffRemoteReviewTarget {
        let trimmedDestination = rawDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedDestination.isEmpty else {
            throw CLIError(message: "--ssh requires a destination")
        }
        let explicitPath = remotePath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let destination: String
        let root: String
        if let explicitPath, !explicitPath.isEmpty {
            destination = trimmedDestination
            root = explicitPath
        } else if let separator = trimmedDestination.lastIndex(of: ":") {
            destination = String(trimmedDestination[..<separator])
            root = String(trimmedDestination[trimmedDestination.index(after: separator)...])
        } else {
            throw CLIError(message: "--ssh requires host:/absolute/review/root or --remote-path")
        }
        guard !destination.isEmpty, root.hasPrefix("/") else {
            throw CLIError(message: "Remote review roots must be absolute paths")
        }
        guard !destination.hasPrefix("-"),
              !destination.unicodeScalars.contains(where: {
                  CharacterSet.controlCharacters.contains($0) ||
                      CharacterSet.whitespacesAndNewlines.contains($0)
              }) else {
            throw CLIError(message: "SSH review destinations may not begin with '-' or contain whitespace/control characters")
        }
        let executable = companionExecutable?.trimmingCharacters(in: .whitespacesAndNewlines)
        return DiffRemoteReviewTarget(
            destination: destination,
            root: root,
            companionExecutable: (executable?.isEmpty == false ? executable! : "cmux")
        )
    }

    func remoteAggregateDiffInput(
        target: DiffRemoteReviewTarget,
        source: DiffSource,
        baseRef: String?
    ) throws -> DiffInput {
        guard source != .lastTurn else {
            throw CLIError(message: "Remote aggregate review does not support last-turn source")
        }
        var command = [
            target.companionExecutable,
            "review-companion",
            "--root", target.root,
            "--source", source.slug,
        ]
        if let baseRef, !baseRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            command.append(contentsOf: ["--base", baseRef])
        }
        // SSH sends the final argument to the remote shell. Quote every token
        // independently so a review root, ref, or companion path can never
        // become shell syntax on the remote host.
        let remoteCommand = command.map(shellQuote).joined(separator: " ")
        let sshArguments = sshArgumentsOverridingHostRemoteCommand([
            // macOS OpenSSH accepts `--` and treats every following token as
            // a hostname/remote command, never as another SSH option.
            "ssh", "-T", "--", target.destination, remoteCommand,
        ])
        let result = CLIProcessRunner.runProcess(
            executablePath: reviewSSHExecutable(),
            arguments: Array(sshArguments.dropFirst()),
            timeout: 180
        )
        guard !result.timedOut, result.status == 0 else {
            throw CLIError(message: remoteReviewCompanionFailureMessage(
                destination: target.destination,
                result: result
            ))
        }
        guard let data = result.stdout.data(using: .utf8) else {
            throw CLIError(message: "Remote host returned non-UTF-8 review-companion data. Update cmux on \(target.destination) and retry.")
        }
        var manifest: DiffReviewAggregateManifest
        do {
            manifest = try JSONDecoder().decode(DiffReviewAggregateManifest.self, from: data)
        } catch {
            throw CLIError(message: "Remote host did not return a compatible review-companion JSON manifest. Update cmux on \(target.destination) and retry.")
        }
        guard manifest.schemaVersion == DiffReviewAggregateManifest.schemaVersion else {
            throw CLIError(message: "Remote review companion protocol version \(manifest.schemaVersion) is unsupported (this cmux requires \(DiffReviewAggregateManifest.schemaVersion)). Update cmux on \(target.destination) and retry.")
        }
        try validateRemoteReviewManifest(manifest, target: target, source: source)
        // The companion intentionally keeps its versioned manifest transport-neutral:
        // `root` values are real paths on the remote host. Before this manifest enters
        // the local viewer, turn each child repository into its durable remote owner.
        // This prevents equal paths on different hosts from sharing comments, and lets
        // the viewer recognize every remote child as an SSH review.
        manifest.repositories = try manifest.repositories.map { repository in
            var repository = repository
            repository.root = try canonicalRemoteCommentRoot(
                destination: target.destination,
                repositoryRoot: repository.root,
                reviewRoot: manifest.root
            )
            return repository
        }
        let patch = manifest.repositories.map(\.patch).filter { !$0.isEmpty }.joined(separator: "\n")
        return DiffInput(
            patch: patch,
            sourceLabel: "remote aggregate git \(source.slug)",
            defaultTitle: "Remote aggregate review",
            emptyMessage: manifest.repositories.isEmpty
                ? "No Git repositories found under the remote path."
                : "No changes found in the remote repositories.",
            externalURL: nil,
            aggregateManifest: manifest
        )
    }

    /// Implements the other end of the SSH protocol. It writes exactly one JSON
    /// manifest to stdout so a caller can consume it without a daemon or a port.
    func runReviewCompanionCommand(commandArgs: [String]) throws {
        var root: String?
        var source: DiffSource = .unstaged
        var baseRef: String?
        var index = 0
        while index < commandArgs.count {
            let argument = commandArgs[index]
            switch argument {
            case "--root":
                guard index + 1 < commandArgs.count else {
                    throw CLIError(message: "review-companion: --root requires a value")
                }
                root = commandArgs[index + 1]
                index += 2
            case "--source":
                guard index + 1 < commandArgs.count, let parsed = DiffSource(rawValue: commandArgs[index + 1]) else {
                    throw CLIError(message: "review-companion: --source must be unstaged, staged, or branch")
                }
                source = parsed
                index += 2
            case "--base":
                guard index + 1 < commandArgs.count else {
                    throw CLIError(message: "review-companion: --base requires a value")
                }
                baseRef = commandArgs[index + 1]
                index += 2
            default:
                throw CLIError(message: "review-companion: unknown option '\(argument)'")
            }
        }
        guard source != .lastTurn else {
            throw CLIError(message: "review-companion: last-turn is not supported")
        }
        guard let root, root.hasPrefix("/") else {
            throw CLIError(message: "review-companion requires an absolute --root")
        }
        let manifest = try aggregateDiffManifest(root: root, source: source, baseRef: baseRef)
        let data = try JSONEncoder().encode(manifest)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    private func aggregateRepositoryIdentifier(_ repository: String, root: String) -> String {
        let standardizedRepository = URL(fileURLWithPath: repository).standardizedFileURL.path
        let standardizedRoot = URL(fileURLWithPath: root).standardizedFileURL.path
        guard standardizedRepository != standardizedRoot else {
            return URL(fileURLWithPath: standardizedRepository).lastPathComponent
        }
        let rootPrefix = standardizedRoot.hasSuffix("/") ? standardizedRoot : standardizedRoot + "/"
        guard standardizedRepository.hasPrefix(rootPrefix) else {
            return URL(fileURLWithPath: standardizedRepository).lastPathComponent
        }
        return String(standardizedRepository.dropFirst(rootPrefix.count))
    }

    /// Uses the system SSH client unless a test/embedded launcher provides an executable override.
    private func reviewSSHExecutable() -> String {
        let environment = ProcessInfo.processInfo.environment
        guard let rawOverride = environment["CMUX_REVIEW_SSH_EXECUTABLE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              rawOverride.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: rawOverride) else {
            return "/usr/bin/ssh"
        }
        return rawOverride
    }

    /// Rejects a reply that is valid JSON but not a reply to this exact request.
    private func validateRemoteReviewManifest(
        _ manifest: DiffReviewAggregateManifest,
        target: DiffRemoteReviewTarget,
        source: DiffSource
    ) throws {
        let expectedRoot = URL(fileURLWithPath: target.root).standardizedFileURL.path
        guard manifest.root == expectedRoot else {
            throw CLIError(message: "Remote review companion returned a manifest for a different root. Expected \(expectedRoot), got \(manifest.root).")
        }
        guard manifest.source == source.slug else {
            throw CLIError(message: "Remote review companion returned source '\(manifest.source)' instead of requested source '\(source.slug)'. Update cmux on \(target.destination) and retry.")
        }

        var repositoryIDs = Set<String>()
        let expectedRootPrefix = expectedRoot.hasSuffix("/") ? expectedRoot : expectedRoot + "/"
        for repository in manifest.repositories {
            let standardizedRepositoryRoot = URL(fileURLWithPath: repository.root).standardizedFileURL.path
            guard !repository.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !repository.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  repository.root.hasPrefix("/"),
                  (standardizedRepositoryRoot == expectedRoot || standardizedRepositoryRoot.hasPrefix(expectedRootPrefix)),
                  repositoryIDs.insert(repository.id).inserted else {
                throw CLIError(message: "Remote review companion returned invalid repository metadata. Update cmux on \(target.destination) and retry.")
            }
            if source == .branch,
               repository.baseRef?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                throw CLIError(message: "Remote review companion omitted the branch base for \(repository.label). Update cmux on \(target.destination) and retry.")
            }
        }
    }

    /// Returns the opaque, host-qualified repository identity used by local comment storage.
    private func canonicalRemoteCommentRoot(
        destination: String,
        repositoryRoot: String,
        reviewRoot: String
    ) throws -> String {
        guard !repositoryRoot.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw CLIError(message: "Remote review companion returned an invalid repository path.")
        }
        let standardizedRepositoryRoot = URL(fileURLWithPath: repositoryRoot).standardizedFileURL.path
        let standardizedReviewRoot = URL(fileURLWithPath: reviewRoot).standardizedFileURL.path
        let reviewRootPrefix = standardizedReviewRoot.hasSuffix("/") ? standardizedReviewRoot : standardizedReviewRoot + "/"
        guard standardizedRepositoryRoot == standardizedReviewRoot || standardizedRepositoryRoot.hasPrefix(reviewRootPrefix) else {
            throw CLIError(message: "Remote review companion returned a repository outside the requested review root.")
        }
        return "ssh://\(destination)\(standardizedRepositoryRoot)"
    }

    /// Converts transport failures into actionable missing/obsolete-companion diagnostics.
    private func remoteReviewCompanionFailureMessage(
        destination: String,
        result: CLIProcessResult
    ) -> String {
        if result.timedOut {
            return "Timed out waiting for the remote review companion on \(destination). Check SSH connectivity and that cmux is installed remotely."
        }
        let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = detail.lowercased()
        if normalized.contains("command not found") ||
            normalized.contains("unknown command") ||
            normalized.contains("not recognized") {
            return "Remote host \(destination) does not have a compatible 'cmux review-companion'. Install or update cmux on the remote host and retry.\(detail.isEmpty ? "" : " Details: \(detail)")"
        }
        if detail.isEmpty {
            return "Remote review companion failed for \(destination). Check SSH access and install a compatible cmux there."
        }
        return "Remote review companion failed for \(destination): \(detail)"
    }

    private func gitAggregateSingleLine(_ arguments: [String], in directory: String) throws -> String {
        let result = CLIProcessRunner.runProcess(
            executablePath: "/usr/bin/env",
            arguments: ["git", "-C", directory] + arguments,
            timeout: 60
        )
        guard !result.timedOut, result.status == 0,
              let line = result.stdout.split(whereSeparator: \.isNewline).first.map(String.init),
              !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CLIError(message: "git \(arguments.joined(separator: " ")) failed in \(directory)")
        }
        return line.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
