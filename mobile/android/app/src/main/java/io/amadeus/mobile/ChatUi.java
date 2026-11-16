package io.amadeus.mobile;

import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.text.*;
import android.text.style.*;
import android.text.util.Linkify;
import android.view.*;
import android.widget.*;
import java.util.regex.*;

final class ChatUi {
  static int dp(Context c, float value) {
    return Math.round(value * c.getResources().getDisplayMetrics().density);
  }

  static GradientDrawable rounded(int color, float radius, Context c) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(dp(c, radius));
    return d;
  }

  static TextView label(Context c, String text, int size, int color) {
    TextView v = new TextView(c);
    v.setText(text);
    v.setTextSize(size);
    v.setTextColor(color);
    v.setFontFeatureSettings("kern");
    return v;
  }

  static CharSequence markdown(String text) {
    String source =
        text.replaceAll("(?m)^#{1,6} +", "")
            .replaceAll("\\[([^\\]]+)\\]\\((https?://[^)]+)\\)", "$1 ($2)");
    SpannableStringBuilder out = new SpannableStringBuilder();
    Matcher m = Pattern.compile("\\*\\*(.+?)\\*\\*|`([^`]+)`", Pattern.DOTALL).matcher(source);
    int offset = 0;
    while (m.find()) {
      out.append(source.substring(offset, m.start()));
      int start = out.length();
      out.append(m.group(1) != null ? m.group(1) : m.group(2));
      out.setSpan(
          m.group(1) != null ? new StyleSpan(Typeface.BOLD) : new TypefaceSpan("monospace"),
          start,
          out.length(),
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
      offset = m.end();
    }
    out.append(source.substring(offset));
    Linkify.addLinks(out, Linkify.WEB_URLS);
    return out;
  }

  static final class Icon extends View {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    final String kind;
    final int color;

    Icon(Context c, String kind, String description, int color, Runnable action) {
      super(c);
      this.kind = kind;
      this.color = color;
      setContentDescription(description);
      setFocusable(true);
      setClickable(true);
      setOnClickListener(v -> action.run());
      setLayoutParams(new LinearLayout.LayoutParams(dp(c, 44), dp(c, 44)));
    }

    @Override
    protected void onDraw(Canvas canvas) {
      super.onDraw(canvas);
      canvas.save();
      float scale = dp(getContext(), 24) / 24f;
      canvas.translate((getWidth() - 24 * scale) / 2, (getHeight() - 24 * scale) / 2);
      canvas.scale(scale, scale);
      paint.setColor(color);
      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeWidth(1.8f);
      paint.setStrokeCap(Paint.Cap.ROUND);
      paint.setStrokeJoin(Paint.Join.ROUND);
      switch (kind) {
        case "menu":
          line(canvas, 4, 6, 20, 6);
          line(canvas, 4, 12, 16, 12);
          line(canvas, 4, 18, 20, 18);
          break;
        case "plus":
          line(canvas, 12, 5, 12, 19);
          line(canvas, 5, 12, 19, 12);
          break;
        case "send":
          line(canvas, 12, 19, 12, 5);
          line(canvas, 5, 12, 12, 5);
          line(canvas, 19, 12, 12, 5);
          break;
        case "mic":
          canvas.drawRoundRect(9, 3, 15, 15, 3, 3, paint);
          canvas.drawArc(6, 7, 18, 19, 0, 180, false, paint);
          line(canvas, 12, 19, 12, 22);
          break;
        case "folder":
          Path folder = new Path();
          folder.moveTo(3, 6);
          folder.lineTo(9, 6);
          folder.lineTo(11, 9);
          folder.lineTo(21, 9);
          folder.lineTo(21, 20);
          folder.lineTo(3, 20);
          folder.close();
          canvas.drawPath(folder, paint);
          break;
        case "chat":
          canvas.drawRoundRect(3, 4, 21, 18, 4, 4, paint);
          line(canvas, 7, 18, 5, 22);
          break;
        case "tavern":
          canvas.drawRoundRect(4, 3, 20, 20, 5, 5, paint);
          canvas.drawCircle(9, 10, 1, paint);
          canvas.drawCircle(15, 10, 1, paint);
          canvas.drawArc(8, 11, 16, 17, 0, 180, false, paint);
          break;
        case "tools":
          canvas.drawRoundRect(3, 3, 10, 10, 2, 2, paint);
          canvas.drawRoundRect(14, 3, 21, 10, 2, 2, paint);
          canvas.drawRoundRect(3, 14, 10, 21, 2, 2, paint);
          canvas.drawRoundRect(14, 14, 21, 21, 2, 2, paint);
          break;
        case "memory":
          canvas.drawCircle(12, 12, 8, paint);
          line(canvas, 8, 9, 16, 9);
          line(canvas, 8, 13, 16, 13);
          line(canvas, 8, 17, 12, 17);
          break;
        case "stop":
          canvas.drawRoundRect(5, 5, 19, 19, 3, 3, paint);
          break;
        case "dots":
          paint.setStyle(Paint.Style.FILL);
          canvas.drawCircle(5, 12, 1.6f, paint);
          canvas.drawCircle(12, 12, 1.6f, paint);
          canvas.drawCircle(19, 12, 1.6f, paint);
          break;
        default:
          canvas.drawCircle(12, 12, 8, paint);
          canvas.drawCircle(12, 12, 3, paint);
      }
      canvas.restore();
    }

    void line(Canvas c, float x, float y, float xx, float yy) {
      c.drawLine(x, y, xx, yy, paint);
    }
  }
}
