import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { getRootDir } from '../pathUtils.js';

export function getAttachmentsDir() {
  return path.join(getRootDir(), 'attachments');
}

export function getAttachmentPath(chatId, attachmentId) {
  return path.join(getAttachmentsDir(), `${chatId}-${attachmentId}.png`);
}

export async function generateImage({ model, prompt, apiKey, chatId, imageData }) {
  let url = model.url;
  let body;
  const headers = { 'Content-Type': 'application/json' };
  if (model.provider === 'openai') {
    headers.Authorization = `Bearer ${apiKey}`;
    if (imageData) {
      url = model.url.replace('/generations', '/edits');
      body = {
        model: model.modelId,
        prompt,
        image: imageData.base64.replace(/^data:image\/[a-zA-Z]+;base64,/, ''),
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json'
      };
    } else {
      body = {
        model: model.modelId,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json'
      };
    }
  } else if (model.provider === 'google') {
    url = `${model.url}?key=${apiKey}`;
    body = { prompt: { text: prompt } };
    if (imageData) {
      body.image = {
        inlineData: {
          mimeType: imageData.fileType || 'image/jpeg',
          data: imageData.base64.replace(/^data:image\/[a-zA-Z]+;base64,/, '')
        }
      };
    }
  } else {
    throw new Error(`Unsupported provider: ${model.provider}`);
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Image generation failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  let b64;
  if (data?.data?.[0]?.b64_json) {
    b64 = data.data[0].b64_json;
  } else if (data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data) {
    b64 = data.candidates[0].content.parts[0].inlineData.data;
  }
  if (!b64) throw new Error('Invalid image data');
  const attachmentId = crypto.randomBytes(8).toString('hex');
  const dir = getAttachmentsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getAttachmentPath(chatId, attachmentId);
  await fs.writeFile(filePath, Buffer.from(b64, 'base64'));
  return { attachmentId, filePath };
}
