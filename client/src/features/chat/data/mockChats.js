// Mock chat history data — shown when the `chatHistory` feature flag is enabled.
// Replace with real API data once chat persistence is implemented.
export const MOCK_CHATS = [
  {
    id: 'c1',
    title: 'iFinder index transparency & DSGVO',
    appId: 'assistant',
    appName: 'iAssistant',
    appColor: '#4f46e5',
    appIcon: 'sparkles',
    group: 'Today',
    snippet:
      'iFinder keeps only the personal data it needs to operate: usernames, email addresses, assigned rights and roles…'
  },
  {
    id: 'c2',
    title: 'Reisekostenabrechnung Oranienburg',
    appId: 'chat',
    appName: 'Chat',
    appColor: '#4f46e5',
    appIcon: 'chat-bubble',
    group: 'Today',
    snippet:
      "For a round trip of roughly 1,020 km at the German mileage rate of €0.30/km you'd claim about €306…"
  },
  {
    id: 'c3',
    title: 'Customer follow-up email draft',
    appId: 'email',
    appName: 'Email Composer',
    appColor: '#2563eb',
    appIcon: 'mail',
    group: 'Today',
    snippet: 'Subject: Following up on our iFinder demo — Thank you again for your time last week…'
  },
  {
    id: 'c4',
    title: 'GDPR vs CCPA clause comparison',
    appId: 'compare',
    appName: 'Regulatory Compare',
    appColor: '#16a34a',
    appIcon: 'document-search',
    group: 'Yesterday',
    snippet:
      'GDPR requires opt-in consent before processing personal data, while CCPA is largely opt-out…'
  },
  {
    id: 'c5',
    title: "Lenovo ThinkPad won't boot",
    appId: 'it',
    appName: 'IT Support',
    appColor: '#4f46e5',
    appIcon: 'cog',
    group: 'Yesterday',
    snippet:
      "Let's start with the basics: Hold the power button for 15 seconds to force a full shutdown…"
  },
  {
    id: 'c6',
    title: 'FAQ: VPN access for contractors',
    appId: 'faqgen',
    appName: 'FAQ Generator',
    appColor: '#4f46e5',
    appIcon: 'document',
    group: 'Yesterday',
    snippet:
      'Q: Can external contractors get VPN access? A: Yes, with a sponsored account and manager approval…'
  },
  {
    id: 'c7',
    title: 'Translate datasheet EN → DE',
    appId: 'translator',
    appName: 'Translator',
    appColor: '#0891b2',
    appIcon: 'globe',
    group: 'Last 7 days',
    snippet: 'Gerne. Senden Sie mir den Text des Datenblatts, und ich übersetze ihn ins Deutsche…'
  },
  {
    id: 'c8',
    title: 'Difficult feedback conversation prep',
    appId: 'coach',
    appName: 'Conversations Coach',
    appColor: '#4f46e5',
    appIcon: 'users',
    group: 'Last 7 days',
    snippet:
      "Let's structure it. Open with a specific observation rather than a judgement, describe the impact…"
  },
  {
    id: 'c9',
    title: 'How to pin an app in iHub',
    appId: 'supportbot',
    appName: 'iHub Support Bot',
    appColor: '#16a34a',
    appIcon: 'question-mark-circle',
    group: 'Last 7 days',
    snippet:
      'Open the app card and click the star in its top-right corner, or right-click the app in the sidebar…'
  },
  {
    id: 'c10',
    title: 'Quarterly report summary',
    appId: 'chat',
    appName: 'Chat',
    appColor: '#4f46e5',
    appIcon: 'chat-bubble',
    group: 'Last 7 days',
    snippet:
      'Q2 highlights: revenue ahead of plan, two major public-sector wins, and the iFinder 6 GA milestone…'
  }
];

export const CHAT_GROUPS = ['Today', 'Yesterday', 'Last 7 days', 'Older'];
