# Right-to-Left Language Support

The application supports RTL languages such as Arabic by dynamically changing the text direction based on the current UI language.

## Testing RTL Mode

1. Install dependencies and start the development environment:
   ```bash
   npm run install:all
   npm run dev
   ```
2. In the running app open `http://localhost:5173/?lng=ar` or choose **Arabic** from the language selector.
3. Verify that the entire layout switches to right-to-left.
4. Navigate through the application and ensure all pages render correctly without layout issues.

To test a production build use `npm run prod:build` followed by `npm run start:prod` and repeat the steps above.
