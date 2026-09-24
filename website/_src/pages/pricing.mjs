export default ({ SITE }) => ({
  file: 'pricing.html',
  title: 'Pricing | iHub Apps',
  description:
    'iHub Apps is free and open source. Run it yourself at no licence cost, or add enterprise support, hosting and services from IntraFind.',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Pricing',
      title: 'Free to run. Support when you want it.',
      lead: 'iHub Apps is open source under a BSD-3-Clause licence with attribution. You pay your model providers directly and nothing per seat to IntraFind. Enterprise support, hosting and services are available on request.',
      ctas: [
        { label: 'Download', href: SITE.releases, primary: true, icon: 'download' },
        { label: 'Talk to sales', href: SITE.contact }
      ]
    },
    {
      type: 'html',
      soft: true,
      html: `<div class="plans">
        <div class="plan">
          <span class="eyebrow">Community</span>
          <div class="price">€0 <small>forever</small></div>
          <p class="muted">Everything in the repository, for any number of users.</p>
          <ul>
            <li>All apps, chat, workflows, agents, integrations, API</li>
            <li>Binary, Docker, npm, Windows service</li>
            <li>OIDC, LDAP, NTLM, proxy authentication</li>
            <li>Bring your own model keys or local models</li>
            <li>Community support on GitHub</li>
            <li>Attribution to IntraFind in the UI and docs</li>
          </ul>
          <a class="btn secondary" href="${SITE.releases}" target="_blank" rel="noopener">Download</a>
        </div>
        <div class="plan featured">
          <span class="eyebrow">Enterprise support</span>
          <div class="price">Custom <small>per organization</small></div>
          <p class="muted">The same open-source product with IntraFind behind it.</p>
          <ul>
            <li>Support contract with response times</li>
            <li>Rollout and use-case workshops</li>
            <li>Custom apps, integrations and renderers</li>
            <li>Security documentation for your review</li>
            <li>Upgrade assistance and roadmap input</li>
            <li>Integration with iFinder and iAssistant</li>
          </ul>
          <a class="btn primary" href="${SITE.contact}">Talk to sales</a>
        </div>
        <div class="plan">
          <span class="eyebrow">Hosted by IntraFind</span>
          <div class="price">Custom <small>per deployment</small></div>
          <p class="muted">Managed operation and model inference in Germany.</p>
          <ul>
            <li>Dedicated GPUs in German data centres</li>
            <li>Tenant separation, end-to-end encryption</li>
            <li>IP allowlisting, no training on your data</li>
            <li>Managed updates and monitoring</li>
            <li>Combine with your own cloud API keys</li>
            <li>Data processing agreement</li>
          </ul>
          <a class="btn secondary" href="${SITE.contact}">Request an offer</a>
        </div>
      </div>
      <p class="note mt-2">Model usage is billed by your provider at their prices. iHub adds no markup and tracks token usage per app, model and user so you can allocate costs internally.</p>`
    },
    {
      type: 'table',
      title: 'What is included',
      columns: ['Capability', 'Community', 'Enterprise support', 'Hosted'],
      rows: [
        ['Chat, apps, prompt library, files, voice, web search', true, true, true],
        ['Workflows, agents, skills, marketplace (preview flags)', true, true, true],
        ['OpenAI-compatible API, MCP gateway, OAuth server', true, true, true],
        ['SSO: OIDC, ADFS, LDAP, NTLM, proxy, Teams', true, true, true],
        ['Outlook add-in, browser extension, Nextcloud app', true, true, true],
        ['Audit log, usage reports, OpenTelemetry', true, true, true],
        ['Updates', 'Self-service', 'Assisted', 'Managed'],
        ['Support', 'GitHub issues', 'Contract with SLA', 'Contract with SLA'],
        [
          'Model hosting',
          'Your keys or hardware',
          'Your keys or hardware',
          'IntraFind GPUs in Germany'
        ],
        ['Custom development', false, true, true],
        [
          'iFinder / iAssistant enterprise search',
          'Connector included',
          'Licence and integration',
          'Licence and integration'
        ]
      ]
    },
    {
      type: 'faq',
      items: [
        {
          q: 'Is it really free for commercial use?',
          a: 'Yes. The BSD-3-Clause licence allows commercial use, modification and redistribution. The only extra condition is visible attribution to IntraFind in the interface and documentation.'
        },
        {
          q: 'What do we pay for models?',
          a: 'Whatever your provider charges. iHub does not resell tokens. Usage reports show consumption per app, model and user for internal charge-back.'
        },
        {
          q: 'Is there a trial for enterprise support?',
          a: 'Start with the free product for your pilot. When you are ready to roll out, contact IntraFind for a support or hosting offer.'
        },
        {
          q: 'Do you offer a hosted SaaS?',
          a: 'IntraFind offers managed deployments and GPU inference in German data centres per customer. Contact sales for details.'
        }
      ]
    },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
