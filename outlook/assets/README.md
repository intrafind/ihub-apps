# Outlook Add-in Assets

This directory should contain the icon files referenced in the manifest.xml.

## Required Icon Sizes

- **icon-16.png**: 16x16 pixels (ribbon icon, small)
- **icon-32.png**: 32x32 pixels (ribbon icon, medium)
- **icon-64.png**: 64x64 pixels (add-in icon)
- **icon-80.png**: 80x80 pixels (ribbon icon, large)
- **icon-128.png**: 128x128 pixels (high-resolution add-in icon)

## Icon Guidelines

- Use PNG format with transparency
- Follow Microsoft Office Add-in icon design guidelines
- Icons should be simple and recognizable
- Use the iHub Apps brand colors
- Consider both light and dark Office themes

## Creating Icons

You can create icons using:

1. Graphic design software (Adobe Illustrator, Figma, etc.)
2. Online icon generators
3. Export from the main iHub Apps logo

## Temporary Placeholder

For development/testing, you can use simple colored squares or the iHub Apps logo resized to appropriate dimensions.

The manifest.xml currently references these files at:

- https://{{APP_URL}}/outlook/assets/icon-16.png
- https://{{APP_URL}}/outlook/assets/icon-32.png
- https://{{APP_URL}}/outlook/assets/icon-64.png
- https://{{APP_URL}}/outlook/assets/icon-80.png
- https://{{APP_URL}}/outlook/assets/icon-128.png

Make sure these files exist before deploying the add-in.
