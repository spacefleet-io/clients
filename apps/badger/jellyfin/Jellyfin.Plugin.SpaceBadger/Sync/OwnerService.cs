using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.SpaceBadger.Sync;

/// <summary>Resolves the one Jellyfin user whose playback syncs back to Badger (INTG-JF-01).</summary>
public sealed class OwnerService
{
    private readonly IUserManager _users;

    public OwnerService(IUserManager users)
    {
        _users = users;
    }

    /// <summary>Gets the owner: the configured user, else the first administrator.</summary>
    public User? GetOwner()
    {
        var configured = Plugin.Instance?.Configuration.OwnerUserId ?? Guid.Empty;
        if (configured != Guid.Empty && _users.GetUserById(configured) is { } user)
        {
            return user;
        }

        return _users.GetUsers().FirstOrDefault(u => u.HasPermission(PermissionKind.IsAdministrator));
    }

    public bool IsOwner(Guid userId) => GetOwner()?.Id == userId;
}
