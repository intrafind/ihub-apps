# iAssistant 1.1.0

- New action **Ask the iAssistant** (`ask`, tool `iassistant__ask`): a model other than the iAssistant asks it one question and gets an answer grounded in the documents in iFinder the user may see. The documents the answer cites become the answer's sources, as in an iAssistant chat, and the sources panel names the iAssistant that answered.
- Whom the action asks: the iAssistant picked in the chat (or pinned by the app) always wins; otherwise the iAssistant the model names, checked against the ones the user can see; otherwise the app's iAssistant settings.
- The action reads only (`sideEffect: read`), stays inside the organisation (`dataFlow: internal`) and runs as the signed-in user (`connection: user`).
- Apps opt in: the action is offered only when the app's iAssistant binding ticks it (`integrations.iassistant.actions: ["ask"]`, **Admin → Apps → Integrations → iAssistant → Use in this app**). Apps that bind the iAssistant for its model keep exactly the tools they had. Nothing in an installation changes; the iAssistant stays selectable as a model.
