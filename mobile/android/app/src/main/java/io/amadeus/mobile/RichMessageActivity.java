package io.amadeus.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.*;
import android.widget.*;
import java.io.ByteArrayInputStream;
import java.util.regex.*;

/** Isolated, offline document renderer. No native bridge, remote requests or filesystem access. */
public class RichMessageActivity extends Activity {
  WebView web;

  static String escape(String s) {
    return s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;");
  }

  @Override
  public void onCreate(Bundle saved) {
    if ((getResources().getConfiguration().uiMode
            & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
        == android.content.res.Configuration.UI_MODE_NIGHT_YES)
      setTheme(android.R.style.Theme_Material_NoActionBar);
    super.onCreate(saved);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    Button close = new Button(this);
    close.setText("返回聊天");
    close.setOnClickListener(v -> finish());
    root.addView(close);
    web = new WebView(this);
    root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
    setContentView(root);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setAllowFileAccess(false);
    web.getSettings().setAllowContentAccess(false);
    web.getSettings().setDomStorageEnabled(false);
    web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            String scheme = r.getUrl().getScheme();
            if (r.isForMainFrame()
                && r.hasGesture()
                && ("https".equals(scheme) || "http".equals(scheme))) {
              try {
                startActivity(
                    new android.content.Intent(android.content.Intent.ACTION_VIEW, r.getUrl()));
              } catch (Exception ignored) {
              }
            }
            return true;
          }

          @Override
          public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            String path = r.getUrl().getPath();
            if ("amadeus.local".equals(r.getUrl().getHost())
                && path != null
                && (path.equals("/katex.min.js")
                    || path.equals("/katex.min.css")
                    || path.equals("/auto-render.min.js")
                    || path.matches("/fonts/KaTeX_[A-Za-z0-9_-]+\\.woff2"))) {
              try {
                return new WebResourceResponse(
                    path.endsWith(".js")
                        ? "application/javascript"
                        : path.endsWith(".css") ? "text/css" : "font/woff2",
                    "UTF-8",
                    getAssets().open("rich" + path));
              } catch (Exception ignored) {
              }
            }
            return new WebResourceResponse(
                "text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
          }
        });
    String source = getIntent().getStringExtra("text");
    if (source == null) source = "";
    String content;
    if (getIntent().getBooleanExtra("html", false)) {
      // Generated HTML stays in a sandboxed frame with scripts and networking disabled.
      String isolated =
          "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src"
              + " 'unsafe-inline'; img-src data:\">"
              + source;
      content =
          "<iframe sandbox='' style='width:100%;height:90vh;border:0' srcdoc=\""
              + escape(isolated)
              + "\"></iframe>";
    } else {
      StringBuilder out = new StringBuilder();
      Matcher blocks = Pattern.compile("(?s)```[^\\n]*\\n(.*?)```").matcher(source);
      int end = 0;
      while (blocks.find()) {
        out.append("<div class='prose'>")
            .append(escape(source.substring(end, blocks.start())))
            .append("</div><pre><code>")
            .append(escape(blocks.group(1)))
            .append("</code></pre>");
        end = blocks.end();
      }
      out.append("<div class='prose'>").append(escape(source.substring(end))).append("</div>");
      content = out.toString();
    }
    String html =
        "<!doctype html><meta name='viewport' content='width=device-width, initial-scale=1'><meta"
            + " http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src"
            + " 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self';"
            + " frame-src 'self' about:\"><link rel='stylesheet'"
            + " href='/katex.min.css'><style>body{font:17px"
            + " system-ui;margin:20px;color:#202124;background:#fafaff}.prose{white-space:pre-wrap;line-height:1.7;overflow-wrap:anywhere}pre{overflow:auto;padding:16px;background:#e9edf5;border-radius:16px}.katex-display{overflow:auto}@media(prefers-color-scheme:dark){body{color:#e9eaf0;background:#131314}pre{background:#26272a}}</style>"
            + content
            + "<script src='/katex.min.js'></script><script"
            + " src='/auto-render.min.js'></script><script>renderMathInElement(document.body,{throwOnError:false,trust:false,delimiters:[{left:'$$',right:'$$',display:true},{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false},{left:'$',right:'$',display:false}]});</script>";
    web.loadDataWithBaseURL("https://amadeus.local/", html, "text/html", "UTF-8", null);
  }

  @Override
  protected void onDestroy() {
    if (web != null) {
      web.stopLoading();
      web.destroy();
    }
    super.onDestroy();
  }
}
