# Watermark Logos Directory

This directory contains SVG logo files used for image watermarking.

## Usage

1. Place SVG logo files in this directory
2. Reference the filename in watermark configuration:

```json
{
  "imageWatermark": {
    "enabled": true,
    "logo": "company-logo.svg",
    "position": "bottom-right",
    "opacity": 0.5
  }
}
```

## Requirements

- **Format**: SVG only
- **Size**: Any size (automatically scaled to 20% of image dimensions)
- **Transparency**: Supported
- **Colors**: Any color scheme

## Examples

### Minimal Logo
```svg
<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#4F46E5"/>
</svg>
```

### Logo with Text
```svg
<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="#4F46E5"/>
  <text x="100" y="60" font-family="Arial" font-size="30" fill="#333">Company</text>
</svg>
```

## Best Practices

1. **Keep it simple**: Logos are scaled down, complex details may be lost
2. **Use vector graphics**: SVG ensures clarity at any size
3. **Test visibility**: Ensure logo is visible at reduced size and opacity
4. **Consider colors**: Logo should be visible on various image backgrounds
5. **Optimize files**: Remove unnecessary SVG metadata and comments

## Example Logo

The `example-logo.svg` file demonstrates a simple circular logo with text.

## Configuration Options

Combine logos with text watermarks:

```json
{
  "imageWatermark": {
    "enabled": true,
    "logo": "company-logo.svg",
    "text": "Company Name",
    "position": "bottom-right",
    "opacity": 0.6
  }
}
```

This creates a side-by-side watermark with logo on left and text on right.

## Troubleshooting

**Logo not appearing:**
- Verify SVG file is valid XML
- Check filename matches configuration
- Ensure file is in `contents/logos/` directory
- Review server logs for errors

**Logo too small/large:**
- Logo is automatically scaled to 20% of image dimensions
- Adjust your SVG viewBox for desired proportions
- Test with different image sizes

**Logo not visible:**
- Increase opacity in configuration
- Use contrasting colors
- Add stroke/outline to logo elements
- Consider adding shadow effect in SVG
