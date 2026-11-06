package expo.modules.sessionwatch

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private class WatchNotStartedException(cause: Throwable) :
  CodedException("ERR_WATCH_NOT_STARTED", "The background connection could not start", cause)

/**
 * Session notices for the phone: the notification permission, the watch
 * ([SessionWatchService]) that keeps the app connected in the background,
 * and the notices themselves. Android only.
 */
class SessionWatchModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SessionWatch")

    /** Whether a notice posted now would be shown: the permission and the app's switch in Android settings. */
    Function("notificationsEnabled") {
      NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * Asks for the notification permission where Android has one (13 and
     * later). Resolves with Expo's permission response; before 13 there is
     * nothing to ask, and the answer is whatever the app's switch says.
     */
    AsyncFunction("requestPermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        promise.resolve(
          mapOf(
            "status" to if (enabled) "granted" else "denied",
            "granted" to enabled,
            "canAskAgain" to false,
            "expires" to "never",
          )
        )
        return@AsyncFunction
      }
      val permissions = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()
      Permissions.askForPermissionsWithPermissionsManager(
        permissions,
        promise,
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    /** The app's notification page in Android settings, for a permission refused for good. */
    Function("openSettings") {
      val intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("isWatching") { SessionWatchService.running }

    /**
     * Starts the watch. Android allows that only while the app is in the
     * foreground; anywhere else this throws, and the next return to the
     * foreground tries again.
     */
    Function("startWatching") {
      try {
        ContextCompat.startForegroundService(context, Intent(context, SessionWatchService::class.java))
      } catch (error: Exception) {
        throw WatchNotStartedException(error)
      }
    }

    /** Stops the watch. Its task should have ended first; this is the backstop. */
    Function("stopWatching") {
      context.stopService(Intent(context, SessionWatchService::class.java))
    }

    /**
     * Posts a notice. `key` names it, so a newer notice for the same session
     * replaces the older; tapping it opens `url` (an `openmanager://` link) in
     * the app.
     */
    Function("notify") { key: String, title: String, body: String, url: String ->
      val context = context
      SessionWatchService.ensureChannels(context)
      val open =
        Intent(Intent.ACTION_VIEW, Uri.parse(url))
          .setPackage(context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val notification =
        NotificationCompat.Builder(context, SessionWatchService.NOTICE_CHANNEL)
          .setSmallIcon(R.drawable.session_watch_icon)
          .setContentTitle(title)
          .setContentText(body)
          .setAutoCancel(true)
          .setCategory(NotificationCompat.CATEGORY_MESSAGE)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setContentIntent(
            PendingIntent.getActivity(
              context,
              key.hashCode(),
              open,
              PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
          )
          .build()
      try {
        NotificationManagerCompat.from(context).notify(key, NOTICE_ID, notification)
      } catch (_: SecurityException) {
        // The permission was taken away since it was checked: nothing to show.
      }
    }

    /** Takes a session's notice away: its session is on screen now. */
    Function("cancel") { key: String ->
      NotificationManagerCompat.from(context).cancel(key, NOTICE_ID)
    }
  }

  private companion object {
    const val NOTICE_ID = 1
  }
}
