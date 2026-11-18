export const getSystemIssueMessage = (issue: string | null) => {
  if (!issue) return null;
  switch (issue) {
    case "maintenance_window":
      return "Library is temporarily read-only during maintenance.";
    case "schema_upgrade_required":
    case "migration_required":
      return "Library is read-only until the migration completes.";
    case "unsupported_app":
      return "This app version is not supported by the backend.";
    default:
      return "Library writes are temporarily blocked due to backend compatibility.";
  }
};

