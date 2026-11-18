# Dot writing assistance on Windows

Open **View → Floating personal agent**, expand the edge tab and select a local Dot conversation. The writing tools share one source document for that Dot window. Select a passage to work on it, or leave the selection empty to process the whole source. Reader feedback has an audience selector, translation has a target language, and source comparison requires reference text. A result appears alongside the editable source. Accept, dismiss or undo it. The writing buffer stays in the window while it is collapsed and is cleared when the binding changes or the window closes.

## Writing in another app

In Dot choose **应用辅助**, select sentence completion, next paragraph or grammar correction, then choose the application's executable. Confirm the displayed model and endpoint. Repeat for other applications. Keep the helper open or minimized. Remove an app or close the helper to stop. Grants last for this helper session. Returning to the editor and continuing to type triggers a suggestion after a pause. Tab accepts the visible suggestion within ten seconds. The suggestion is never submitted as a chat message.

The helper checks the foreground application and focused editor before reading. A request contains at most the last 512 characters of the current line before the caret. The receiver is the model of the approved local Dot conversation. Changing the conversation or model destination requires new approval. There is no document or keystroke log. The helper uses a temporary Windows Tab hotkey while the candidate is visible; an existing hotkey reservation can make Tab unavailable.

Supported editors include standard Win32 Edit/RichEdit controls and plain UI Automation Edit controls with a verifiable caret and a writable Value pattern. The generic setter supports short fields (up to 2,000 characters) at their end. Password, read-only or unidentified controls and selections are skipped. Applications using custom canvas editors, terminals or rich document surfaces may lack the necessary interfaces. For those, paste a passage into the Dot writing panel. Requires interactive Windows PowerShell with .NET Framework and UI Automation.

Run `tests/windows-writing.ps1` on an interactive Windows desktop to exercise the native fixture. The test reports separately whether it obtained foreground focus and exercised a real Tab. The Electron smoke test covers switching tools, accepting, undoing and preserving a draft across collapse.
