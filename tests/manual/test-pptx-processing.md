# Manual Test Plan: PPTX File Upload

## Test Overview
Verify that PowerPoint (.pptx) files can be uploaded and processed correctly, with text content extracted from all slides.

## Prerequisites
1. Start the development environment: `npm run dev`
2. Navigate to an app with file upload enabled (e.g., AI Chat)
3. Prepare test PPTX files with various characteristics

## Test Cases

### Test 1: Basic PPTX Upload
**Objective**: Verify basic PPTX file upload and text extraction

**Steps**:
1. Create a simple PPTX file with 3-5 slides containing text
2. Click the file upload (paperclip) icon in the chat input
3. Select the PPTX file
4. Observe the file preview

**Expected Results**:
- ✓ File uploads successfully
- ✓ Preview shows extracted text from slides
- ✓ Text is properly formatted with slide separators
- ✓ File size is reasonable (text-only, not binary data)

### Test 2: Large Presentation
**Objective**: Verify handling of presentations with many slides

**Steps**:
1. Create or use a PPTX file with 20+ slides
2. Upload the file
3. Send a message asking the AI to summarize the presentation

**Expected Results**:
- ✓ File uploads successfully
- ✓ Token count is reasonable (not exceeding limits)
- ✓ All slides are processed
- ✓ AI can understand and summarize content

### Test 3: Minimal Text Presentation
**Objective**: Verify handling of presentations with mostly images

**Steps**:
1. Create a PPTX with slides containing mostly images and minimal text
2. Upload the file

**Expected Results**:
- ✓ File uploads successfully
- ✓ Available text is extracted
- ✓ No errors about missing content
- ✓ Token usage is minimal

### Test 4: Special Characters
**Objective**: Verify handling of special characters and formatting

**Steps**:
1. Create a PPTX with special characters (emojis, symbols, non-Latin scripts)
2. Upload the file

**Expected Results**:
- ✓ Special characters are preserved
- ✓ Text is readable
- ✓ No encoding errors

### Test 5: Error Handling
**Objective**: Verify graceful error handling

**Steps**:
1. Try to upload a corrupted PPTX file
2. Try to upload a renamed non-PPTX file with .pptx extension

**Expected Results**:
- ✓ Clear error message is displayed
- ✓ No system crash
- ✓ User can try again with a different file

### Test 6: Token Reduction Verification
**Objective**: Verify significant token reduction compared to binary upload

**Steps**:
1. Upload a 10-slide PPTX file
2. Check the token count in the browser console or network tab
3. Compare with expected text-only token count

**Expected Results**:
- ✓ Token count is proportional to text content only
- ✓ Approximately 100-200 tokens per slide (depending on content)
- ✓ 80-95% reduction vs. binary upload

### Test 7: Slide Order Preservation
**Objective**: Verify slides are processed in correct order

**Steps**:
1. Create a PPTX with numbered slides (Slide 1, Slide 2, etc.)
2. Upload and check the extracted text

**Expected Results**:
- ✓ Slides appear in correct order
- ✓ Slide separators show correct numbers
- ✓ Text flow makes sense

### Test 8: Integration with AI
**Objective**: Verify AI can properly process PPTX content

**Steps**:
1. Upload a PPTX about a specific topic
2. Ask questions about the content
3. Request summaries or analysis

**Expected Results**:
- ✓ AI understands the content
- ✓ AI can reference specific slides
- ✓ Responses are accurate and contextual

## Sample Test PPTX Content

### Simple Test Presentation (3 slides):
```
Slide 1:
Title: Welcome to iHub Apps
Subtitle: Testing PPTX Upload

Slide 2:
Title: Key Features
- AI-powered applications
- Multiple file format support
- Easy to use interface

Slide 3:
Title: Conclusion
Thank you for testing!
```

## Verification Checklist

After completing all tests:
- [ ] PPTX files upload without errors
- [ ] Text is correctly extracted from all slides
- [ ] Slide order is preserved
- [ ] Token usage is significantly reduced
- [ ] Special characters are handled correctly
- [ ] Error messages are clear and helpful
- [ ] AI can process and understand the content
- [ ] No regression in other file types (PDF, DOCX, etc.)

## Known Limitations

1. **Images**: Images in slides are not extracted (text-only)
2. **Speaker Notes**: Speaker notes are not included
3. **Charts**: Chart data is not extracted
4. **Legacy PPT**: Binary .ppt format may not work (only PPTX tested)
5. **Formatting**: Text formatting (bold, italic, colors) is not preserved

## Reporting Issues

If any test fails, report with:
- Test case number
- Steps to reproduce
- Expected vs. actual results
- Browser console errors (if any)
- Sample PPTX file (if not confidential)
