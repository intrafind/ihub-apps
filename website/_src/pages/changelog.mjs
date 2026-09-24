export default ({ SITE, changelogSections }) => ({
  file: 'changelog.html',
  title: 'Changelog | iHub Apps',
  description:
    'What is new in every iHub Apps release: features, fixes and breaking changes, generated from the in-product release notes.',
  sections: [
    {
      type: 'hero',
      eyebrow: 'Changelog',
      title: 'What’s new in iHub Apps.',
      lead: `We ship continuously. This page is generated from the same release notes that appear under Admin → What’s New inside the product. Current version: ${SITE.version}.`,
      ctas: [
        { label: 'All releases on GitHub', href: SITE.releases, primary: true, icon: 'github' },
        { label: 'Download latest', href: SITE.releases, icon: 'download' }
      ]
    },
    { type: 'html', html: changelogSections() },
    { type: 'cta' },
    { type: 'trust' }
  ]
});
