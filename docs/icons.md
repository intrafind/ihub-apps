# Icons

iHub Apps uses [Heroicons v2](https://heroicons.com/) as its built-in icon library. All icons are
available in **outline** (default) and **solid** variants. Custom SVG icons can also be added to
extend the built-in set.

## Using Icons in App Configuration

When configuring an app's `icon` field or any other icon property, use the **short name** listed
in the tables below:

```json
{
  "id": "my-app",
  "icon": "sparkles"
}
```

Icon names can also be used in `config/ui.json` for UI element overrides (see
[UI Configuration](ui.md#icons-configuration)):

```json
"icons": {
  "assistantMessage": "sparkles",
  "userMessage": "user"
}
```

## Icon Formats

Icon values accept two formats:

- **Short name** (e.g., `"sparkles"`) — resolves to the built-in Heroicon or to
  `/icons/{name}.svg` if no built-in icon matches. Custom SVGs placed under `public/icons/`
  override built-in icons of the same name.
- **Direct path or URL** (e.g., `"/uploads/assets/my-logo.svg"`) — used as-is. Upload custom
  assets via the admin panel's **Assets** tab and paste the URL here.

## Sizes

The `Icon` React component supports the following sizes:

| Size token | CSS classes | Pixels (approx.) |
| ---------- | ----------- | ---------------- |
| `xs`       | `w-3 h-3`   | 12 px            |
| `sm`       | `w-4 h-4`   | 16 px            |
| `md`       | `w-5 h-5`   | 20 px _(default)_ |
| `lg`       | `w-6 h-6`   | 24 px            |
| `xl`       | `w-8 h-8`   | 32 px            |
| `2xl`      | `w-12 h-12` | 48 px            |

## Built-in Icons

All icons below are backed by **Heroicons v2** (`@heroicons/react` v2.2). Each icon supports an
`outline` (default) and a `solid` variant.

### App & Content Icons

These icons are most commonly used as app `icon` values:

| Name                  | Heroicon                        | Description                   |
| --------------------- | ------------------------------- | ----------------------------- |
| `academic-cap`        | AcademicCapIcon                 | Graduation cap                |
| `beaker`              | BeakerIcon                      | Laboratory beaker             |
| `briefcase`           | BriefcaseIcon                   | Briefcase / work              |
| `calendar`            | CalendarIcon                    | Calendar                      |
| `camera`              | CameraIcon                      | Camera                        |
| `chart-bar`           | ChartBarIcon                    | Bar chart (also: `chart`)     |
| `clock`               | ClockIcon                       | Clock / time                  |
| `code`                | CodeBracketIcon                 | Code brackets (also: `code-bracket`) |
| `color-swatch`        | SwatchIcon                      | Color swatch                  |
| `cpu-chip`            | CpuChipIcon                     | CPU / microchip               |
| `document-search`     | DocumentMagnifyingGlassIcon     | Document with magnifying glass |
| `document-text`       | DocumentTextIcon                | Document with text (also: `file-text`) |
| `globe`               | GlobeAltIcon                    | Globe / Earth                 |
| `information-circle`  | InformationCircleIcon           | Information in a circle (also: `info`) |
| `light-bulb`          | LightBulbIcon                   | Light bulb / idea             |
| `mail`                | EnvelopeIcon                    | Email / envelope              |
| `microphone`          | MicrophoneIcon                  | Microphone                    |
| `paint-brush`         | PaintBrushIcon                  | Paint brush                   |
| `presentation-chart-bar` | PresentationChartBarIcon     | Presentation chart            |
| `question-mark-circle`| QuestionMarkCircleIcon          | Question mark in a circle     |
| `share`               | ShareIcon                       | Share                         |
| `sparkles`            | SparklesIcon                    | Sparkles / magic              |
| `ticket`              | TicketIcon                      | Ticket                        |
| `users`               | UsersIcon                       | Group of people               |

### Navigation & UI Icons

| Name              | Heroicon                    | Description                           |
| ----------------- | --------------------------- | ------------------------------------- |
| `arrow-left`      | ArrowLeftIcon               | Arrow pointing left (also: `arrowLeft`) |
| `arrow-right`     | ArrowRightIcon              | Arrow pointing right                  |
| `arrow-up`        | ArrowUpIcon                 | Arrow pointing up (also: `send`)      |
| `chevron-down`    | ChevronDownIcon             | Chevron pointing down                 |
| `chevron-left`    | ChevronLeftIcon             | Chevron pointing left                 |
| `chevron-right`   | ChevronRightIcon            | Chevron pointing right                |
| `chevron-up`      | ChevronUpIcon               | Chevron pointing up                   |
| `close`           | XMarkIcon                   | Close / X mark (also: `x`)            |
| `external-link`   | ArrowTopRightOnSquareIcon   | Open in new tab / external link       |
| `home`            | HomeIcon                    | House / home                          |
| `list`            | ListBulletIcon              | Bullet list                           |
| `login`           | ArrowRightIcon              | Login (arrow right)                   |
| `logout`          | ArrowLeftIcon               | Logout (arrow left)                   |
| `menu`            | Bars3Icon                   | Hamburger menu (also: `format`)       |
| `search`          | MagnifyingGlassIcon         | Magnifying glass (also: `magnifying-glass`) |

### Action Icons

| Name            | Heroicon           | Description                                   |
| --------------- | ------------------ | --------------------------------------------- |
| `check`         | CheckIcon          | Checkmark                                     |
| `check-circle`  | CheckCircleIcon    | Checkmark in a circle                         |
| `clipboard`     | ClipboardIcon      | Clipboard (also: `copy`)                      |
| `download`      | ArrowDownTrayIcon  | Download arrow                                |
| `edit`          | PencilSquareIcon   | Edit / pencil with square                     |
| `minus-circle`  | MinusCircleIcon    | Minus / remove in a circle                    |
| `paper-clip`    | PaperClipIcon      | Paper clip / attachment                       |
| `pencil`        | PencilIcon         | Pencil                                        |
| `play`          | PlayIcon           | Play button                                   |
| `plus`          | PlusCircleIcon     | Plus in a circle (also: `plus-circle`)        |
| `plus-circle`   | PlusCircleIcon     | Plus in a circle                              |
| `redo`          | ArrowUturnRightIcon | Redo arrow                                   |
| `refresh`       | ArrowPathIcon      | Rotating arrows / refresh (also: `arrow-path`) |
| `save`          | CheckIcon          | Save (uses checkmark icon)                    |
| `star`          | StarIcon           | Star / favorite                               |
| `trash`         | TrashIcon          | Trash / delete                                |
| `undo`          | ArrowUturnLeftIcon | Undo arrow                                    |
| `upload`        | ArrowUpTrayIcon    | Upload arrow                                  |

### Communication & Feedback Icons

| Name                   | Heroicon                  | Description                               |
| ---------------------- | ------------------------- | ----------------------------------------- |
| `chat`                 | ChatBubbleLeftRightIcon   | Chat bubbles (also: `chat-bubbles`, `chat-bubble`, `chat-bubble-left-right`) |
| `chat-bubble-left`     | ChatBubbleLeftIcon        | Single chat bubble                        |
| `exclamation-circle`   | ExclamationCircleIcon     | Exclamation mark in a circle              |
| `exclamation-triangle` | ExclamationTriangleIcon   | Warning triangle (also: `warning`)        |
| `face-frown`           | FaceFrownIcon             | Frowning face                             |
| `thumbs-down`          | HandThumbDownIcon         | Thumbs down                               |
| `thumbs-up`            | HandThumbUpIcon           | Thumbs up                                 |

### User & Security Icons

| Name                   | Heroicon                    | Description                                   |
| ---------------------- | --------------------------- | --------------------------------------------- |
| `key`                  | KeyIcon                     | Key / authentication                          |
| `shield-alert`         | ShieldExclamationIcon       | Shield with exclamation                       |
| `shield-check`         | ShieldCheckIcon             | Shield with checkmark                         |
| `user`                 | UserIcon                    | Single person                                 |

### Settings & Admin Icons

| Name                    | Heroicon                      | Description                              |
| ----------------------- | ----------------------------- | ---------------------------------------- |
| `adjustments-vertical`  | AdjustmentsVerticalIcon       | Vertical adjustment sliders              |
| `cog`                   | Cog6ToothIcon                 | Gear / settings (also: `settings`)       |
| `funnel`                | FunnelIcon                    | Filter funnel                            |
| `sliders`               | AdjustmentsHorizontalIcon     | Horizontal adjustment sliders            |
| `wrench`                | WrenchIcon                    | Wrench / tool                            |

### Storage & Data Icons

| Name               | Heroicon                    | Description                              |
| ------------------ | --------------------------- | ---------------------------------------- |
| `archive-box`      | ArchiveBoxIcon              | Archive box                              |
| `cloud`            | CloudIcon                   | Cloud                                    |
| `cloud-arrow-up`   | CloudArrowUpIcon            | Cloud with upload arrow                  |
| `database`         | CircleStackIcon             | Stacked circles / database               |
| `document`         | DocumentIcon                | Plain document                           |
| `document-duplicate` | DocumentDuplicateIcon     | Duplicate documents                      |
| `document-plus`    | DocumentPlusIcon            | Document with plus sign                  |
| `folder`           | FolderIcon                  | Folder                                   |
| `folder-open`      | FolderOpenIcon              | Open folder                              |
| `hard-drive`       | ServerIcon                  | Server / hard drive                      |
| `layers`           | RectangleStackIcon          | Stacked layers                           |
| `table`            | TableCellsIcon              | Table grid (also: `table-cells`)         |

### Visibility & Media Icons

| Name          | Heroicon        | Description                           |
| ------------- | --------------- | ------------------------------------- |
| `eye`         | EyeIcon         | Eye / visible                         |
| `eye-slash`   | EyeSlashIcon    | Eye with slash / hidden               |
| `signal`      | SignalIcon      | Signal / antenna                      |

### Theme Icons

| Name               | Heroicon             | Description                            |
| ------------------ | -------------------- | -------------------------------------- |
| `computer-desktop` | ComputerDesktopIcon  | Desktop computer / system theme        |
| `moon`             | MoonIcon             | Moon / dark mode                       |
| `sun`              | SunIcon              | Sun / light mode                       |

### Misc Icons

| Name     | Heroicon   | Description      |
| -------- | ---------- | ---------------- |
| `link`   | LinkIcon   | Chain link / URL |

## Custom SVG Icons

You can add your own SVG icons to extend or override the built-in set by placing them in the
`public/icons/` directory (or the directory specified by the `VITE_ICON_BASE_URL` environment
variable).

**Steps:**

1. Create a directory `public/icons/` in the project root (if it doesn't exist).
2. Place your SVG file there, e.g., `public/icons/my-brand-logo.svg`.
3. Reference it by its file name without the `.svg` extension, e.g., `"my-brand-logo"`.

```json
{
  "icon": "my-brand-logo"
}
```

Custom SVG files placed in `public/icons/` **override** built-in icons of the same name. This
means you can replace a Heroicon with your own artwork by simply using the same name.

### Example: Custom App Icon

```
public/
  icons/
    company-logo.svg
    product-icon.svg
```

```json
{
  "id": "company-assistant",
  "icon": "company-logo"
}
```

### Uploading via the Admin Panel

You can also upload SVG (or other image) files through the admin panel:

1. Go to **Admin → System → Assets** and upload your file.
2. Copy the resulting URL (e.g., `/uploads/assets/company-logo.svg`).
3. Use the full path as the icon value:

```json
{
  "icon": "/uploads/assets/company-logo.svg"
}
```

## Icon Picker in the Admin UI

When editing an app in the admin panel (**Admin → Apps → Edit**), the **Icon** field shows an
interactive icon picker with a live search over all built-in icon names. This makes it easy to
browse and select the right icon without memorising the full list.

## Heroicons Reference

All built-in icons are sourced from [Heroicons v2](https://heroicons.com/) by Tailwind Labs.
Visit the Heroicons website to preview every available icon and find the exact name you need.

The library version currently bundled is **`@heroicons/react` v2.2.0**.
