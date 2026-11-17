package io.amadeus.mobile;

import android.accessibilityservice.*;
import android.graphics.*;
import android.os.*;
import android.view.accessibility.*;
import java.util.concurrent.*;
import org.json.*;

public class ScreenService extends AccessibilityService {
  public static volatile ScreenService instance;

  @Override
  protected void onServiceConnected() {
    instance = this;
  }

  @Override
  public void onDestroy() {
    instance = null;
    super.onDestroy();
  }

  @Override
  public void onAccessibilityEvent(AccessibilityEvent event) {}

  @Override
  public void onInterrupt() {}

  Object perform(String action, JSONObject args) throws Exception {
    CompletableFuture<Object> result = new CompletableFuture<>();
    new Handler(Looper.getMainLooper())
        .post(
            () -> {
              try {
                if (!DotService.active) throw new Exception("Control session stopped");
                if (action.equals("screen.read")) {
                  JSONArray nodes = new JSONArray();
                  visit(getRootInActiveWindow(), nodes, 0);
                  result.complete(
                      new JSONObject()
                          .put("nodes", nodes)
                          .put("coordinates", "physical screen pixels"));
                  return;
                }
                if (action.equals("screen.back") || action.equals("screen.home")) {
                  result.complete(
                      new JSONObject()
                          .put(
                              "dispatched",
                              performGlobalAction(
                                  action.equals("screen.back")
                                      ? GLOBAL_ACTION_BACK
                                      : GLOBAL_ACTION_HOME)));
                  return;
                }
                int width = getResources().getDisplayMetrics().widthPixels,
                    height = getResources().getDisplayMetrics().heightPixels;
                float x = (float) args.getDouble(action.equals("screen.tap") ? "x" : "x1"),
                    y = (float) args.getDouble(action.equals("screen.tap") ? "y" : "y1");
                if (x < 0 || y < 0 || x >= width || y >= height)
                  throw new Exception("Coordinate outside screen");
                Path path = new Path();
                path.moveTo(x, y);
                if (action.equals("screen.swipe")) {
                  float x2 = (float) args.getDouble("x2"), y2 = (float) args.getDouble("y2");
                  if (x2 < 0 || y2 < 0 || x2 >= width || y2 >= height)
                    throw new Exception("Coordinate outside screen");
                  path.lineTo(x2, y2);
                }
                GestureDescription gesture =
                    new GestureDescription.Builder()
                        .addStroke(
                            new GestureDescription.StrokeDescription(
                                path, 0, action.equals("screen.tap") ? 80 : 400))
                        .build();
                boolean accepted =
                    dispatchGesture(
                        gesture,
                        new GestureResultCallback() {
                          @Override
                          public void onCompleted(GestureDescription g) {
                            result.complete("Gesture delivered; read screen to verify outcome");
                          }

                          @Override
                          public void onCancelled(GestureDescription g) {
                            result.completeExceptionally(
                                new Exception("Gesture cancelled; inspect screen before retrying"));
                          }
                        },
                        null);
                if (!accepted) throw new Exception("Gesture rejected");
              } catch (Exception e) {
                result.completeExceptionally(e);
              }
            });
    return result.get(8, TimeUnit.SECONDS);
  }

  void visit(AccessibilityNodeInfo node, JSONArray out, int depth) throws Exception {
    if (node == null || depth > 20 || out.length() >= 200) return;
    try {
      if (!node.isPassword() && node.isVisibleToUser()) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        out.put(
            new JSONObject()
                .put("text", String.valueOf(node.getText()))
                .put("description", String.valueOf(node.getContentDescription()))
                .put("clickable", node.isClickable())
                .put(
                    "bounds",
                    new JSONArray(
                        new int[] {bounds.left, bounds.top, bounds.right, bounds.bottom})));
      }
      for (int i = 0; i < node.getChildCount() && out.length() < 200; i++)
        visit(node.getChild(i), out, depth + 1);
    } finally {
      node.recycle();
    }
  }
}
