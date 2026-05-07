export const version = '034';
export const description = 'add_global_prompt_variables_custom_variables';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');

  // Add the variables field to globalPromptVariables if it doesn't exist
  if (platform.globalPromptVariables) {
    // If globalPromptVariables exists but doesn't have variables, add it
    ctx.setDefault(platform, 'globalPromptVariables.variables', {});
    ctx.log('Added variables field to existing globalPromptVariables');
  } else {
    // If globalPromptVariables doesn't exist at all, create it with both fields
    ctx.setDefault(platform, 'globalPromptVariables', {
      context:
        "Very important: The user's timezone is {{timezone}}. The current date is {{date}}. Any dates before this are in the past, and any dates after this are in the future. When dealing with modern entities/companies/people, and the user asks for the 'latest', 'most recent', 'today's', etc. don't assume your knowledge is up to date; You can and should speak any language the user asks you to speak or use the language of the user. \n",
      variables: {}
    });
    ctx.log('Created globalPromptVariables with context and variables fields');
  }

  await ctx.writeJson('config/platform.json', platform);
  ctx.log('Migration completed: Global prompt variables now support custom variables');
}
