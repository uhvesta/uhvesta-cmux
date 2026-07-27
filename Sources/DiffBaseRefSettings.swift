import Foundation
import CmuxSettings

/// Stores the optional branch-diff base override shared by the CLI and the
/// review settings UI.
struct DiffBaseRefSettings {
    static let workspaceOverridesKey = "diffViewer.branchBaseRef.workspaceOverrides"

    // UserDefaults is documented thread-safe; the reference is immutable and
    // every operation is a single synchronous read or write.
    private nonisolated(unsafe) let defaults: UserDefaults

    init(defaults: UserDefaults? = nil) {
        if let defaults {
            self.defaults = defaults
        } else if let bundleID = ProcessInfo.processInfo.environment["CMUX_BUNDLE_ID"],
                  let suiteDefaults = UserDefaults(suiteName: bundleID) {
            self.defaults = suiteDefaults
        } else {
            self.defaults = .standard
        }
    }

    /// Returns the normalized global default, or nil when unset.
    func globalBaseRef() -> String? {
        normalized(defaults.string(forKey: SettingCatalog().app.diffViewerBranchBaseRef.userDefaultsKey))
    }

    /// Returns a workspace override, preferring the restart-stable workspace id
    /// and falling back to the runtime id for older socket payloads.
    func workspaceBaseRef(stableWorkspaceId: String?, runtimeWorkspaceId: String?) -> String? {
        let overrides = defaults.dictionary(forKey: Self.workspaceOverridesKey) as? [String: String] ?? [:]
        for key in [stableWorkspaceId, runtimeWorkspaceId].compactMap({ normalized($0) }) {
            if let override = normalized(overrides[key]) {
                return override
            }
        }
        return nil
    }

    /// Returns the workspace override when present, then the global default.
    func resolvedBaseRef(stableWorkspaceId: String?, runtimeWorkspaceId: String?) -> String? {
        workspaceBaseRef(stableWorkspaceId: stableWorkspaceId, runtimeWorkspaceId: runtimeWorkspaceId)
            ?? globalBaseRef()
    }

    /// Persists or clears the override for one workspace identity.
    func setWorkspaceBaseRef(_ value: String?, stableWorkspaceId: String?, runtimeWorkspaceId: String?) {
        let keys = [stableWorkspaceId, runtimeWorkspaceId].compactMap({ normalized($0) })
        guard !keys.isEmpty else { return }
        var overrides = defaults.dictionary(forKey: Self.workspaceOverridesKey) as? [String: String] ?? [:]
        if let value = normalized(value) {
            for key in keys { overrides[key] = value }
        } else {
            for key in keys { overrides.removeValue(forKey: key) }
        }
        if overrides.isEmpty {
            defaults.removeObject(forKey: Self.workspaceOverridesKey)
        } else {
            defaults.set(overrides, forKey: Self.workspaceOverridesKey)
        }
    }

    private func normalized(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
