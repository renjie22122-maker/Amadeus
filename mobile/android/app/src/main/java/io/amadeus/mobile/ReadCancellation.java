package io.amadeus.mobile;

import java.net.HttpURLConnection;

/** A selection owns its read. Cancelling never replays a mutation. */
final class ReadCancellation {
  private boolean cancelled;
  private HttpURLConnection active;

  synchronized boolean attach(HttpURLConnection connection) {
    if (cancelled) return false;
    active = connection;
    return true;
  }

  synchronized boolean isCancelled() {
    return cancelled;
  }

  synchronized void release(HttpURLConnection connection) {
    if (active == connection) active = null;
  }

  void cancel() {
    HttpURLConnection connection;
    synchronized (this) {
      cancelled = true;
      connection = active;
      active = null;
    }
    if (connection != null) connection.disconnect();
  }
}
