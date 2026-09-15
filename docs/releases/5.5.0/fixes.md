# Fixes — 5.5.0

## More Room for the Conversation on Phones

On a phone the chat gave the conversation less than half the screen: a 390x664 viewport spent 392px
on chrome and left 272px for messages. Several pieces are now compact below the `sm` breakpoint,
which also covers the Outlook taskpane and the browser-extension side panel.

- The app header uses a smaller icon, back button and title, and less padding.
- The status line above the input no longer squeezes the context-window counter into a narrow
  column, so "~290 / 32,768 context tokens" fits on one line instead of wrapping.
- The disclaimer below the input gets the full row width, and the incognito toggle shows just its
  icon; the toggle keeps its name for screen readers.
- The toolbar row and send button are slightly tighter.

The conversation now gets 339px of the same 664px viewport, up from 272px. Layouts from `sm` up are
unchanged.

## The Footer No Longer Takes a Permanent Strip on Phones

In the sidebar layout the slim footer was pinned to the bottom of the viewport, costing about 57px
of a ~660px phone screen on every content page and clipping the content above it. On small screens
it now sits after the content and scrolls out of the way; on desktop, where it is a single 36px
line, it stays pinned as before.

## Model Descriptions No Longer Leave a Gap in the Model Picker

In the model picker on iOS, rows whose description was long showed one line of text followed by a
tall empty box, so the list looked randomly spaced. The single-line description now uses ordinary
truncation instead of a line clamp, whose height WebKit computes from the full unclamped text when
the element sits inside a flex item. Two-line descriptions from `sm` up are bounded by an explicit
maximum height for the same reason.

## One Unreachable Model Endpoint No Longer Stalls Every Other Chat

When a model endpoint could not be reached — typically a local vLLM behind a VPN that was not
connected — a chat to that model hung for the full 5-minute request timeout, and while it hung,
chats from other users to other, healthy models hung as well. Pages and menus kept loading; only
answers stopped.

The cause was hostname resolution. Node resolves hostnames on a small shared threadpool and lets only
two lookups run at a time. A lookup for an unreachable host blocked one of those slots for the
operating system's resolver timeout, could not be cancelled by stopping the chat, and one chat turn
issued several of them. Every other outbound request in the process then waited in the queue.

- Outbound connections now share one lookup per hostname, give up on a lookup after 5 seconds, and
  remember a failed host for 30 seconds so new requests to it fail immediately. A chat to an
  unreachable model fails within seconds with "endpoint could not be reached", and other chats are
  unaffected.
- A connect timeout is no longer retried, and a failed model auto-discovery is remembered for 60
  seconds, so a dead endpoint is probed once rather than five times per message.
- The server sizes Node's threadpool to 16 threads unless `UV_THREADPOOL_SIZE` is set.
- New environment variables: `DNS_LOOKUP_TIMEOUT_MS` (default `5000`), `DNS_NEGATIVE_CACHE_MS`
  (default `30000`), `UV_THREADPOOL_SIZE` (default `16`). See
  [Server Configuration](../../server-config.md).
- A chat request whose `Accept-Language` header is not a language tag (`*`, sent by some HTTP
  clients) no longer fails with an internal error; the platform's default language is used for date
  formatting in prompts.

## Starting a Chat From the Start Page Keeps Your Model on Slow Devices

Typing a message on the start page and pressing Enter opens the chosen app and
sends the message straight away. On a phone — or any device where the app and
the model list took a moment longer to arrive — the message was sent before the
app's settings had been applied, so it went out with no model at all and came
back as **Invalid request** instead of an answer. When it did get through, it
could still use the wrong temperature, because the app's configured value had
not been applied yet either.

- The message now waits for the app's model list before it is sent, so the model
  you picked on the start page (or the app's default) is the one that answers.
- Desktops were never affected: the fixed 100 ms head start the send used to
  rely on was always enough there, and always too short on a phone.

## A Model That Stops Mid-Answer No Longer Hangs the Chat for Five Minutes

If a model endpoint sent part of an answer and then went quiet — without
closing the connection or marking the answer finished — the chat stayed stuck
in its "answering" state: the text that had arrived sat on screen with the stop
button still lit, the typing indicator still running and no answer-source badge,
until the five-minute request deadline finally expired. Self-hosted
OpenAI-compatible servers are the usual culprits.

- Once an answer has started arriving, a gap of more than 60 seconds with no
  further data now ends the turn and reports that the endpoint stopped sending.
  The part of the answer that did arrive stays on screen and the message can be
  sent again.
- The wait *before* the first piece of an answer is unchanged, so a model that
  thinks for a long time before it starts writing is not cut off.
