package expo.modules.sessionwatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * The watch: a foreground service that keeps the app's JavaScript running
 * while the app is in the background, so the environment's socket stays open
 * and a session that finishes can raise a notice.
 *
 * Three things keep it alive, all from [HeadlessJsTaskService]:
 * - the foreground service itself, so Android neither freezes nor kills the
 *   process and Doze leaves its network alone;
 * - a headless JS task that runs for as long as the watch does, which keeps
 *   React Native's timers firing with no activity on screen (the socket's
 *   10 s beats are timers, and the server closes a socket that misses two);
 * - the partial wake lock the base class holds while the service lives, so
 *   the CPU does not sleep through those beats.
 *
 * The JavaScript side owns the task (`watch.ts`): it ends the task to stop,
 * and the base class stops the service once no task is left.
 */
class SessionWatchService : HeadlessJsTaskService() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannels(this)
    val notification = ongoing(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
    } else {
      startForeground(ONGOING_ID, notification)
    }
    running = true
    // A second start (the app came back to the front) keeps the one task.
    if (!taskStarted) {
      taskStarted = true
      super.onStartCommand(intent, flags, startId)
    }
    // Not restarted by the system after it kills the process: a fresh process
    // has no screen and no connection, and would watch nothing.
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    // No timeout, and allowed while the app is on screen: the watch starts
    // from Settings, in the foreground, and lasts until it is turned off.
    HeadlessJsTaskConfig(TASK_KEY, Arguments.createMap(), 0, true)

  override fun onDestroy() {
    running = false
    taskStarted = false
    super.onDestroy()
  }

  companion object {
    const val TASK_KEY = "OpenManagerSessionWatch"
    const val WATCH_CHANNEL = "session-watch"
    const val NOTICE_CHANNEL = "session-notices"
    private const val ONGOING_ID = 0x5e55

    @Volatile var running = false
      private set

    @Volatile private var taskStarted = false

    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      // The watch's own notice: required while it runs, so as quiet as allowed.
      manager.createNotificationChannel(
        NotificationChannel(WATCH_CHANNEL, "Background connection", NotificationManager.IMPORTANCE_MIN)
          .apply {
            description = "Shown while OpenManager stays connected to watch your sessions."
            setShowBadge(false)
          }
      )
      manager.createNotificationChannel(
        NotificationChannel(NOTICE_CHANNEL, "Sessions", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "A session finished, needs your input, or stopped with an error."
        }
      )
    }

    private fun ongoing(context: Context): Notification {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val open =
        launch?.let {
          PendingIntent.getActivity(
            context,
            0,
            it,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          )
        }
      return NotificationCompat.Builder(context, WATCH_CHANNEL)
        .setSmallIcon(R.drawable.session_watch_icon)
        .setContentTitle("Watching your sessions")
        .setContentText("Turn off in Settings → Notifications")
        .setOngoing(true)
        .setSilent(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(open)
        .build()
    }
  }
}
