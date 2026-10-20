# Features — 5.5.44

## Skills: Enable Skills per App in the App Editor

**Admin → Apps → Skills** now has an **Enable skills in this app** switch. With it on, the skill
picker and the **Allow users' personal skills** switch (`skillSettings.allowPersonal`) appear below
it. With it off, the app sends no skill list and no skill tools, which keeps simple apps small and
focused. See the breaking change for how existing apps are migrated.
