# Jira 1.0.0

- First version of the built-in Jira definition. The installation `jira` holds the OAuth client (client id, client secret reference, redirect URI) and the site URL that used to live in `platform.jira`.
- Six actions keep their tool ids: `jira_searchTickets`, `jira_getTicket`, `jira_addComment`, `jira_getTransitions`, `jira_transitionTicket`, `jira_getAttachment`. Every user connects their own Atlassian account; stored user tokens are untouched.
