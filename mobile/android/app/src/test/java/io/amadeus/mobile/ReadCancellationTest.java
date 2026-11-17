package io.amadeus.mobile;
import org.junit.Test;import static org.junit.Assert.*;import java.net.*;
public class ReadCancellationTest {
 static class Connection extends HttpURLConnection {boolean disconnected;Connection()throws Exception{super(new URL("https://example.invalid"));}public void disconnect(){disconnected=true;}public boolean usingProxy(){return false;}public void connect(){}}
 @Test public void changingConversationDisconnectsItsPendingRead()throws Exception{ReadCancellation old=new ReadCancellation(),next=new ReadCancellation();Connection a=new Connection(),b=new Connection();assertTrue(old.attach(a));old.cancel();assertTrue(next.attach(b));assertTrue(a.disconnected);assertFalse(b.disconnected);assertTrue(old.isCancelled());assertFalse(next.isCancelled());}
 @Test public void cancelledQueuedReadCannotStartLater()throws Exception{ReadCancellation c=new ReadCancellation();c.cancel();assertFalse(c.attach(new Connection()));}
 @Test public void releaseDoesNotCancelAnotherRead()throws Exception{ReadCancellation c=new ReadCancellation();Connection a=new Connection(),b=new Connection();c.attach(a);c.release(a);c.attach(b);c.release(a);c.cancel();assertTrue(b.disconnected);}
}
