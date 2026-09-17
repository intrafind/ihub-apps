export const version = '030';
export const description = 'add_office_integration_starter_prompts';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  ctx.setDefault(platform, 'officeIntegration.starterPrompts', [
    {
      title: { en: 'Summarize this email', de: 'Fasse diese E-Mail zusammen' },
      message: { en: 'Summarize this email', de: 'Fasse diese E-Mail zusammen' }
    },
    {
      title: {
        en: 'Summarize and reply to this email',
        de: 'Fasse diese E-Mail zusammen und antworte darauf'
      },
      message: {
        en: 'Summarize and reply to this email',
        de: 'Fasse diese E-Mail zusammen und antworte darauf'
      }
    },
    {
      title: {
        en: 'What are the main takeaways from this email?',
        de: 'Was sind die wichtigsten Erkenntnisse aus dieser E-Mail?'
      },
      message: {
        en: 'What are the main takeaways from this email?',
        de: 'Was sind die wichtigsten Erkenntnisse aus dieser E-Mail?'
      }
    }
  ]);

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Added officeIntegration.starterPrompts defaults');
}
