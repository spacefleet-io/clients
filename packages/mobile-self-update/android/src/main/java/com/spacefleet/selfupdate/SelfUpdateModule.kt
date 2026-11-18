package com.spacefleet.selfupdate

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * REL-UPD-06: the Android side of the self-update of a Badger or Parrot APK installed by hand. Linked into every
 * Google-free build (SF_FOSS=1, packages/mobile-shell/foss.cjs); the Play build never contains it, nor the
 * REQUEST_INSTALL_PACKAGES permission of its manifest.
 *
 * It reads who installed the app, fetches the signed repository entry, downloads and checks files (UpdateChecks), and
 * hands the APK to the system installer through a PackageInstaller session; Android shows its own confirmation.
 */
class SelfUpdateModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val io = Executors.newSingleThreadExecutor()

    @Volatile
    private var cancelled = false
    private var statusReceiver: BroadcastReceiver? = null

    override fun getName() = NAME

    private val pm: PackageManager
        get() = reactApplicationContext.packageManager

    private val updateDir: File
        get() = File(reactApplicationContext.cacheDir, "self-update").apply { mkdirs() }

    override fun initialize() {
        super.initialize()
        // A new process: an update downloaded before is either installed or abandoned, so its files can go.
        io.execute { updateDir.listFiles()?.forEach { it.delete() } }
    }

    override fun invalidate() {
        statusReceiver?.let { runCatching { reactApplicationContext.unregisterReceiver(it) } }
        statusReceiver = null
        io.shutdownNow()
        super.invalidate()
    }

    /** `{ installing, initiating }`: the install source Android recorded for this app (nulls when none). */
    @ReactMethod
    fun getInstallSource(promise: Promise) {
        val pkg = reactApplicationContext.packageName
        val result = Arguments.createMap()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val info = pm.getInstallSourceInfo(pkg)
                result.putString("installing", info.installingPackageName)
                result.putString("initiating", info.initiatingPackageName)
            } else {
                @Suppress("DEPRECATION")
                result.putString("installing", pm.getInstallerPackageName(pkg))
                result.putNull("initiating")
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("install_source_failed", e.message, e)
        }
    }

    /** `{ packageName, versionName, versionCode, signers }` of the installed app; signers are certificate SHA-256s. */
    @ReactMethod
    fun getInstalledApp(promise: Promise) {
        try {
            val info = packageInfo(null)
            val result = Arguments.createMap()
            result.putString("packageName", info.packageName)
            result.putString("versionName", info.versionName)
            result.putDouble("versionCode", versionCode(info).toDouble())
            result.putArray("signers", Arguments.fromList(signers(info)))
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("installed_app_failed", e.message, e)
        }
    }

    /** The repository's `entry.json`, read from `entry.jar` once its signature checks out against `fingerprint`. */
    @ReactMethod
    fun fetchRepoEntry(repoUrl: String, fingerprint: String, promise: Promise) {
        io.execute {
            val jar = File(updateDir, "entry.jar")
            try {
                download("${repoUrl.trimEnd('/')}/entry.jar", jar, MAX_ENTRY_BYTES, null)
                promise.resolve(UpdateChecks.verifiedEntryJson(jar, fingerprint))
            } catch (e: UpdateCheckFailed) {
                promise.reject(e.code, e.message, e)
            } catch (e: Exception) {
                promise.reject("network", e.message, e)
            } finally {
                jar.delete()
            }
        }
    }

    /** A small file the verified entry names (the index), as text, once its size and SHA-256 match. */
    @ReactMethod
    fun fetchVerifiedText(url: String, sha256: String, size: Double, promise: Promise) {
        io.execute {
            val file = File(updateDir, "index.json")
            try {
                download(url, file, size.toLong(), null)
                UpdateChecks.requireFile(file, sha256, size.toLong())
                promise.resolve(file.readText())
            } catch (e: UpdateCheckFailed) {
                promise.reject(e.code, e.message, e)
            } catch (e: Exception) {
                promise.reject("network", e.message, e)
            } finally {
                file.delete()
            }
        }
    }

    /**
     * Downloads the new APK with `selfUpdateProgress` events, then checks it: the size and SHA-256 the signed index
     * gives, this app's package name, a higher version code, and the same signing certificates as the installed app.
     * Resolves the APK's path; anything else deletes the file and rejects.
     */
    @ReactMethod
    fun downloadApk(url: String, sha256: String, size: Double, promise: Promise) {
        cancelled = false
        io.execute {
            val apk = File(updateDir, "update.apk")
            try {
                download(url, apk, size.toLong()) { received -> emitProgress(received, size.toLong()) }
                UpdateChecks.requireFile(apk, sha256, size.toLong())
                val installed = packageInfo(null)
                val archive = packageInfo(apk) ?: throw UpdateCheckFailed("not_an_apk", "the download is not an APK")
                if (archive.packageName != installed.packageName) throw UpdateCheckFailed("wrong_app", archive.packageName)
                if (versionCode(archive) <= versionCode(installed)) throw UpdateCheckFailed("not_newer", "${versionCode(archive)}")
                if (!UpdateChecks.sameSigners(signers(archive), signers(installed))) {
                    throw UpdateCheckFailed("wrong_signer", "the APK is not signed with this app's key")
                }
                Log.i(TAG, "verified ${archive.versionName} (${versionCode(archive)})")
                promise.resolve(apk.absolutePath)
            } catch (e: Exception) {
                apk.delete()
                val code = when {
                    e is UpdateCheckFailed -> e.code
                    cancelled -> "cancelled"
                    else -> "network"
                }
                Log.w(TAG, "download failed: $code ${e.message}")
                promise.reject(code, e.message, e)
            }
        }
    }

    @ReactMethod
    fun cancelDownload() {
        cancelled = true
    }

    /** Whether Android lets this app ask to install packages ("install unknown apps" for this app). */
    @ReactMethod
    fun canRequestPackageInstalls(promise: Promise) {
        promise.resolve(pm.canRequestPackageInstalls())
    }

    /** Opens the system "install unknown apps" switch for this app; false when the device has no such screen. */
    @ReactMethod
    fun openInstallPermission(promise: Promise) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${reactApplicationContext.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            // Some Android TV builds have no such screen: the installer then asks itself.
            Log.w(TAG, "no unknown-apps screen: ${e.message}")
            promise.resolve(false)
        }
    }

    /**
     * Hands the verified APK to the system installer in a PackageInstaller session. Android shows its own
     * confirmation; each outcome comes back as a `selfUpdateStatus` event (`{ status, message }`, status one of
     * `confirm`, `success`, `failure`, `aborted`). On success Android stops this process and the new version starts
     * next time.
     */
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    @ReactMethod
    fun install(path: String, promise: Promise) {
        val apk = File(path)
        if (apk.parentFile?.canonicalPath != updateDir.canonicalPath || !apk.isFile) {
            promise.reject("not_an_apk", "no verified update at $path")
            return
        }
        ensureStatusReceiver()
        io.execute {
            try {
                val installer = pm.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(reactApplicationContext.packageName)
                params.setSize(apk.length())
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // An update of an app this app installed itself can then skip the confirmation (Android 12+).
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    apk.inputStream().use { input ->
                        session.openWrite("base.apk", 0, apk.length()).use { out ->
                            input.copyTo(out)
                            session.fsync(out)
                        }
                    }
                    val callback = Intent(STATUS_ACTION).setPackage(reactApplicationContext.packageName)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                    session.commit(PendingIntent.getBroadcast(reactApplicationContext, sessionId, callback, flags).intentSender)
                }
                Log.i(TAG, "session $sessionId committed")
                promise.resolve(null)
            } catch (e: Exception) {
                Log.w(TAG, "install failed: ${e.message}")
                promise.reject("install_failed", e.message, e)
            }
        }
    }

    // NativeEventEmitter bookkeeping.
    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun ensureStatusReceiver() {
        if (statusReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                Log.i(TAG, "install status $status $message")
                when (status) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        @Suppress("DEPRECATION")
                        val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        } else {
                            intent.getParcelableExtra(Intent.EXTRA_INTENT)
                        }
                        if (confirm != null) {
                            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            ctx.startActivity(confirm)
                        }
                        emitStatus("confirm", message)
                    }
                    PackageInstaller.STATUS_SUCCESS -> emitStatus("success", message)
                    PackageInstaller.STATUS_FAILURE_ABORTED -> emitStatus("aborted", message)
                    else -> emitStatus("failure", message)
                }
            }
        }
        val filter = IntentFilter(STATUS_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactApplicationContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactApplicationContext.registerReceiver(receiver, filter)
        }
        statusReceiver = receiver
    }

    /** Streams `url` into `dest` (via a `.part` file), refusing more than `maxBytes`. Follows HTTPS redirects only. */
    private fun download(url: String, dest: File, maxBytes: Long, onProgress: ((Long) -> Unit)?) {
        var address = URL(url)
        var connection: HttpURLConnection
        var redirects = 0
        while (true) {
            if (address.protocol != "https") throw IOException("refusing ${address.protocol} address")
            connection = (address.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = false
                // No identifiers: the same request from every install.
                setRequestProperty("User-Agent", "SpaceFleet-Android-Update")
            }
            val code = connection.responseCode
            if (code in 300..399 && redirects < 5) {
                address = URL(address, connection.getHeaderField("Location") ?: throw IOException("redirect without Location"))
                connection.disconnect()
                redirects += 1
                continue
            }
            if (code != 200) throw IOException("HTTP $code for $address")
            break
        }
        val part = File(dest.parentFile, "${dest.name}.part")
        try {
            var received = 0L
            var reported = -1L
            connection.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelled && onProgress != null) throw IOException("cancelled")
                        val read = input.read(buffer)
                        if (read < 0) break
                        received += read
                        if (received > maxBytes) throw UpdateCheckFailed("size_mismatch", "$address is larger than $maxBytes bytes")
                        out.write(buffer, 0, read)
                        // About every percent.
                        if (onProgress != null && received - reported >= maxBytes / 100) {
                            reported = received
                            onProgress(received)
                        }
                    }
                }
            }
            onProgress?.invoke(received)
            if (!part.renameTo(dest)) throw IOException("could not move ${part.name}")
        } finally {
            part.delete()
            connection.disconnect()
        }
    }

    /** The installed app's package info (`apk` null) or the archive's, with its signing certificates. */
    @Suppress("DEPRECATION")
    private fun packageInfo(apk: File?): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        if (apk == null) return pm.getPackageInfo(reactApplicationContext.packageName, flags)
        val archive = pm.getPackageArchiveInfo(apk.absolutePath, flags)
        // Android 9 and 10 leave signingInfo out of archive info: the v1 signatures are the same certificates.
        if (archive != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && archive.signingInfo == null) {
            return pm.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNATURES) ?: archive
        }
        return archive ?: throw UpdateCheckFailed("not_an_apk", "the download is not an APK")
    }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): List<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            info.signingInfo!!.apkContentsSigners
        } else {
            info.signatures
        }
        return signatures.orEmpty().map { UpdateChecks.sha256Hex(it.toByteArray()) }
    }

    private fun emitProgress(received: Long, total: Long) = emit(PROGRESS_EVENT, Arguments.createMap().apply {
        putDouble("received", received.toDouble())
        putDouble("total", total.toDouble())
    })

    private fun emitStatus(status: String, message: String?) = emit(STATUS_EVENT, Arguments.createMap().apply {
        putString("status", status)
        putString("message", message)
    })

    private fun emit(event: String, body: WritableMap) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, body)
    }

    companion object {
        const val NAME = "SelfUpdate"
        private const val TAG = "SelfUpdate"
        private const val PROGRESS_EVENT = "selfUpdateProgress"
        private const val STATUS_EVENT = "selfUpdateStatus"
        private const val STATUS_ACTION = "com.spacefleet.selfupdate.INSTALL_STATUS"
        private const val MAX_ENTRY_BYTES = 1L shl 20
    }
}
