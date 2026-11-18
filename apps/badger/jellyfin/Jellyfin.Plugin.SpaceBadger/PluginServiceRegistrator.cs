using Jellyfin.Plugin.SpaceBadger.Playback;
using Jellyfin.Plugin.SpaceBadger.Sidecar;
using Jellyfin.Plugin.SpaceBadger.Sync;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.SpaceBadger;

/// <summary>Registers the plugin's services, hosted workers and the playback-source filter.</summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<SidecarClient>();
        serviceCollection.AddSingleton<SidecarDownloader>();
        serviceCollection.AddSingleton<SidecarSupervisor>();
        serviceCollection.AddSingleton<IHostedService>(sp => sp.GetRequiredService<SidecarSupervisor>());
        serviceCollection.AddSingleton<OwnerService>();
        serviceCollection.AddSingleton<LibraryWriter>();
        serviceCollection.AddSingleton<UnpaidNotifier>();
        serviceCollection.AddSingleton<LibrarySynchronizer>();
        serviceCollection.AddSingleton<IHostedService>(sp => sp.GetRequiredService<LibrarySynchronizer>());
        serviceCollection.AddSingleton<IHostedService, PlaybackForwarder>();
        serviceCollection.Configure<MvcOptions>(options => options.Filters.Add<PlaybackSourceFilter>());
    }
}
