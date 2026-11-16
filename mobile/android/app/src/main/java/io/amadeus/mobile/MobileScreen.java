package io.amadeus.mobile;

import android.app.*;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import java.util.concurrent.*;

abstract class MobileScreen extends Activity {
  LinearLayout content;
  TextView feedback;
  int bg, fg, muted, surface, accent;
  final ExecutorService jobs = Executors.newSingleThreadExecutor();

  interface Task {
    void run() throws Exception;
  }

  @Override
  public void onCreate(Bundle saved) {
    boolean dark = (getResources().getConfiguration().uiMode & 48) == 32;
    setTheme(
        dark
            ? android.R.style.Theme_Material_NoActionBar
            : android.R.style.Theme_Material_Light_NoActionBar);
    super.onCreate(saved);
    bg = dark ? 0xff111318 : 0xfff7f8fc;
    fg = dark ? 0xffe9ecf5 : 0xff222636;
    muted = dark ? 0xffa2aec2 : 0xff627089;
    surface = dark ? 0xff222731 : 0xffe9edf6;
    accent = dark ? 0xffb8c8ff : 0xff5267bf;
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.setBackgroundColor(bg);
    content = new LinearLayout(this);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setPadding(dp(22), dp(18), dp(22), dp(30));
    scroll.addView(content);
    setContentView(scroll);
    scroll.setOnApplyWindowInsetsListener(
        (v, i) -> {
          android.graphics.Insets bars =
              i.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
          v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
          return i;
        });
    TextView back = text("‹  返回", 16, accent);
    back.setOnClickListener(v -> finish());
    feedback = text("", 13, muted);
  }

  int dp(int n) {
    return ChatUi.dp(this, n);
  }

  TextView text(String value, int size, int color) {
    TextView t = ChatUi.label(this, value, size, color);
    t.setPadding(0, dp(10), 0, dp(10));
    content.addView(t);
    return t;
  }

  void heading(String title, String subtitle) {
    text(title, 30, fg);
    text(subtitle, 14, muted);
  }

  TextView button(String title, Runnable action) {
    TextView b = ChatUi.label(this, title, 16, fg);
    b.setPadding(dp(18), dp(18), dp(18), dp(18));
    b.setBackground(ChatUi.rounded(surface, 20, this));
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(7), 0, dp(7));
    content.addView(b, p);
    b.setOnClickListener(v -> action.run());
    return b;
  }

  EditText field(String hint, String value) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setText(value);
    e.setTextColor(fg);
    e.setHintTextColor(muted);
    e.setTextSize(16);
    e.setPadding(dp(16), dp(14), dp(16), dp(14));
    e.setBackground(ChatUi.rounded(surface, 16, this));
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(7), 0, dp(7));
    content.addView(e, p);
    return e;
  }

  void work(Task task) {
    jobs.execute(
        () -> {
          try {
            task.run();
          } catch (Exception e) {
            runOnUiThread(
                () -> {
                  if (!isDestroyed())
                    feedback.setText(e.getMessage() == null ? "操作未完成" : e.getMessage());
                });
          }
        });
  }

  @Override
  protected void onDestroy() {
    jobs.shutdownNow();
    super.onDestroy();
  }
}
