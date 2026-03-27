/**
 * ihub admin — Remote administration commands for iHub instances
 * Usage: ihub admin <subcommand> [options]
 * Subcommands: users, groups, config, cache
 */
import { c, symbols } from '../utils/colors.js';
import { parseServerArgs, getServerUrl } from '../utils/api.js';
import {
  parseRemoteArgs,
  isRemoteMode,
  remoteRequest,
  getDisplayUrl
} from '../utils/remote-api.js';

const HELP = `
  ${c.bold('ihub admin')} — Remote administration commands

  ${c.bold('Usage:')}
    ihub admin <subcommand> [options]

  ${c.bold('User Management:')}
    users list                   List all users
    users show <username>        Show user details
    users create <username>      Create a new user
    users delete <username>      Delete a user
    users groups <username>      Show user's groups
    users add-group <user> <group>     Add user to group
    users remove-group <user> <group>  Remove user from group

  ${c.bold('Group Management:')}
    groups list                  List all groups
    groups show <id>             Show group details and permissions
    groups create <id>           Create a new group
    groups delete <id>           Delete a group

  ${c.bold('Configuration:')}
    config get <key>             Get configuration value
    config set <key> <value>     Set configuration value
    config list                  List all configuration

  ${c.bold('Cache Management:')}
    cache clear                  Clear server cache
    cache reload                 Reload configuration from disk

  ${c.bold('Options:')}
    --url <url>          Remote instance URL
    --token <token>      Authentication token
    --instance <name>    Use saved remote instance
    --json               Output as JSON

  ${c.bold('Examples:')}
    ihub admin users list --instance prod
    ihub admin users create john.doe --url https://ihub.example.com
    ihub admin groups show admin --instance prod
    ihub admin config get platform.defaultLanguage
    ihub admin cache clear
`;

/**
 * Get base URL and token from args
 */
function getConnectionInfo(args) {
  const remoteArgs = parseRemoteArgs(args);
  const isRemote = isRemoteMode(remoteArgs);

  if (!isRemote) {
    console.error(`${symbols.error} Admin commands require a remote instance`);
    console.error(`  Use --url, --token, or --instance flags`);
    process.exit(1);
  }

  return {
    baseUrl: remoteArgs.url,
    token: remoteArgs.token,
    sslVerify: remoteArgs.sslVerify,
    remainingArgs: remoteArgs.remainingArgs
  };
}

/**
 * User management commands
 */
async function usersCommand(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    console.error(`${symbols.error} Usage: ihub admin users <subcommand>`);
    console.error(`  Available: list, show, create, delete, groups, add-group, remove-group`);
    process.exit(1);
  }

  const { baseUrl, token, remainingArgs } = getConnectionInfo(rest);
  const asJson = remainingArgs.includes('--json');

  switch (subcommand) {
    case 'list': {
      const response = await remoteRequest(baseUrl, '/api/admin/users', { method: 'GET' }, { token });
      const users = await response.json();

      if (asJson) {
        console.log(JSON.stringify(users, null, 2));
      } else {
        console.log('');
        console.log(`  ${c.bold('Users')} (${users.length})`);
        console.log(`  ${c.gray('─'.repeat(60))}`);

        for (const user of users) {
          console.log(`  ${symbols.success} ${c.white(user.username || user.email || user.id)}`);
          if (user.name) console.log(`    ${c.gray('Name:')} ${user.name}`);
          if (user.groups) console.log(`    ${c.gray('Groups:')} ${user.groups.join(', ')}`);
          console.log('');
        }
      }
      break;
    }

    case 'show': {
      const username = remainingArgs[0];
      if (!username) {
        console.error(`${symbols.error} Usage: ihub admin users show <username>`);
        process.exit(1);
      }

      const response = await remoteRequest(baseUrl, `/api/admin/users/${username}`, { method: 'GET' }, { token });
      const user = await response.json();

      if (asJson) {
        console.log(JSON.stringify(user, null, 2));
      } else {
        console.log('');
        console.log(`  ${c.bold('User Details')}`);
        console.log(`  ${c.gray('─'.repeat(40))}`);
        console.log(`  ${c.gray('Username:')} ${user.username || user.id}`);
        if (user.email) console.log(`  ${c.gray('Email:')}    ${user.email}`);
        if (user.name) console.log(`  ${c.gray('Name:')}     ${user.name}`);
        if (user.groups) console.log(`  ${c.gray('Groups:')}   ${user.groups.join(', ')}`);
        console.log('');
      }
      break;
    }

    case 'create': {
      const username = remainingArgs[0];
      if (!username) {
        console.error(`${symbols.error} Usage: ihub admin users create <username>`);
        process.exit(1);
      }

      // Interactive prompts for user details
      let clack;
      try {
        clack = await import('@clack/prompts');
      } catch {
        console.error(`${symbols.error} @clack/prompts required for interactive creation`);
        process.exit(1);
      }

      const { text, password: passwordPrompt, multiselect } = clack;

      const email = await text({
        message: 'Email:',
        validate: val => {
          if (!val.includes('@')) return 'Invalid email address';
        }
      });

      const name = await text({
        message: 'Full Name:',
        placeholder: 'John Doe'
      });

      const pwd = await passwordPrompt({
        message: 'Password:',
        validate: val => {
          if (val.length < 8) return 'Password must be at least 8 characters';
        }
      });

      // Get available groups
      const groupsResponse = await remoteRequest(baseUrl, '/api/admin/groups', { method: 'GET' }, { token });
      const availableGroups = await groupsResponse.json();

      const groups = await multiselect({
        message: 'Groups:',
        options: availableGroups.map(g => ({
          value: g.id,
          label: `${g.name} - ${g.description || 'No description'}`
        }))
      });

      // Create user
      const response = await remoteRequest(
        baseUrl,
        '/api/admin/users',
        {
          method: 'POST',
          body: JSON.stringify({ username, email, name, password: pwd, groups })
        },
        { token }
      );

      const user = await response.json();

      console.log(`${symbols.success} User created: ${c.cyan(user.username || user.id)}`);
      break;
    }

    case 'delete': {
      const username = remainingArgs[0];
      if (!username) {
        console.error(`${symbols.error} Usage: ihub admin users delete <username>`);
        process.exit(1);
      }

      // Confirm deletion
      let clack;
      try {
        clack = await import('@clack/prompts');
      } catch {}

      if (clack) {
        const { confirm, isCancel } = clack;
        const proceed = await confirm({
          message: `Delete user "${username}"?`,
          initialValue: false
        });

        if (isCancel(proceed) || !proceed) {
          console.log('Cancelled');
          return;
        }
      }

      await remoteRequest(baseUrl, `/api/admin/users/${username}`, { method: 'DELETE' }, { token });

      console.log(`${symbols.success} User deleted: ${username}`);
      break;
    }

    case 'groups': {
      const username = remainingArgs[0];
      if (!username) {
        console.error(`${symbols.error} Usage: ihub admin users groups <username>`);
        process.exit(1);
      }

      const response = await remoteRequest(baseUrl, `/api/admin/users/${username}/groups`, { method: 'GET' }, { token });
      const groups = await response.json();

      if (asJson) {
        console.log(JSON.stringify(groups, null, 2));
      } else {
        console.log('');
        console.log(`  ${c.bold('Groups for')} ${username}`);
        console.log(`  ${c.gray('─'.repeat(40))}`);
        for (const group of groups) {
          console.log(`  ${symbols.success} ${group.name} (${group.id})`);
        }
        console.log('');
      }
      break;
    }

    case 'add-group': {
      const [username, groupId] = remainingArgs;
      if (!username || !groupId) {
        console.error(`${symbols.error} Usage: ihub admin users add-group <username> <group-id>`);
        process.exit(1);
      }

      await remoteRequest(
        baseUrl,
        `/api/admin/users/${username}/groups`,
        {
          method: 'POST',
          body: JSON.stringify({ groupId })
        },
        { token }
      );

      console.log(`${symbols.success} Added ${username} to group ${groupId}`);
      break;
    }

    case 'remove-group': {
      const [username, groupId] = remainingArgs;
      if (!username || !groupId) {
        console.error(`${symbols.error} Usage: ihub admin users remove-group <username> <group-id>`);
        process.exit(1);
      }

      await remoteRequest(baseUrl, `/api/admin/users/${username}/groups/${groupId}`, { method: 'DELETE' }, { token });

      console.log(`${symbols.success} Removed ${username} from group ${groupId}`);
      break;
    }

    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

/**
 * Group management commands
 */
async function groupsCommand(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    console.error(`${symbols.error} Usage: ihub admin groups <subcommand>`);
    console.error(`  Available: list, show, create, delete`);
    process.exit(1);
  }

  const { baseUrl, token, remainingArgs } = getConnectionInfo(rest);
  const asJson = remainingArgs.includes('--json');

  switch (subcommand) {
    case 'list': {
      const response = await remoteRequest(baseUrl, '/api/admin/groups', { method: 'GET' }, { token });
      const groups = await response.json();

      if (asJson) {
        console.log(JSON.stringify(groups, null, 2));
      } else {
        console.log('');
        console.log(`  ${c.bold('Groups')} (${groups.length})`);
        console.log(`  ${c.gray('─'.repeat(60))}`);

        for (const group of groups) {
          console.log(`  ${symbols.success} ${c.white(group.name)} (${c.gray(group.id)})`);
          if (group.description) console.log(`    ${c.gray(group.description)}`);
          if (group.inherits && group.inherits.length > 0) {
            console.log(`    ${c.gray('Inherits:')} ${group.inherits.join(', ')}`);
          }
          console.log('');
        }
      }
      break;
    }

    case 'show': {
      const groupId = remainingArgs[0];
      if (!groupId) {
        console.error(`${symbols.error} Usage: ihub admin groups show <group-id>`);
        process.exit(1);
      }

      const response = await remoteRequest(baseUrl, `/api/admin/groups/${groupId}`, { method: 'GET' }, { token });
      const group = await response.json();

      if (asJson) {
        console.log(JSON.stringify(group, null, 2));
      } else {
        console.log('');
        console.log(`  ${c.bold('Group Details')}`);
        console.log(`  ${c.gray('─'.repeat(40))}`);
        console.log(`  ${c.gray('ID:')}          ${group.id}`);
        console.log(`  ${c.gray('Name:')}        ${group.name}`);
        if (group.description) console.log(`  ${c.gray('Description:')} ${group.description}`);
        if (group.inherits) console.log(`  ${c.gray('Inherits:')}     ${group.inherits.join(', ')}`);

        if (group.permissions) {
          console.log('');
          console.log(`  ${c.bold('Permissions:')}`);
          console.log(`  ${c.gray('Apps:')}   ${group.permissions.apps?.join(', ') || 'none'}`);
          console.log(`  ${c.gray('Models:')} ${group.permissions.models?.join(', ') || 'none'}`);
          console.log(`  ${c.gray('Admin:')}  ${group.permissions.adminAccess ? 'yes' : 'no'}`);
        }
        console.log('');
      }
      break;
    }

    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

/**
 * Configuration management commands
 */
async function configCommand(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    console.error(`${symbols.error} Usage: ihub admin config <subcommand>`);
    console.error(`  Available: get, set, list`);
    process.exit(1);
  }

  const { baseUrl, token, remainingArgs } = getConnectionInfo(rest);
  const asJson = remainingArgs.includes('--json');

  switch (subcommand) {
    case 'list': {
      const response = await remoteRequest(baseUrl, '/api/admin/configs/platform', { method: 'GET' }, { token });
      const config = await response.json();

      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case 'get': {
      const key = remainingArgs[0];
      if (!key) {
        console.error(`${symbols.error} Usage: ihub admin config get <key>`);
        process.exit(1);
      }

      const response = await remoteRequest(baseUrl, '/api/admin/configs/platform', { method: 'GET' }, { token });
      const config = await response.json();

      // Navigate to key
      const parts = key.split('.');
      let value = config;
      for (const part of parts) {
        value = value[part];
        if (value === undefined) {
          console.error(`${symbols.error} Key not found: ${key}`);
          process.exit(1);
        }
      }

      console.log(JSON.stringify(value, null, 2));
      break;
    }

    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

/**
 * Cache management commands
 */
async function cacheCommand(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    console.error(`${symbols.error} Usage: ihub admin cache <subcommand>`);
    console.error(`  Available: clear, reload`);
    process.exit(1);
  }

  const { baseUrl, token } = getConnectionInfo(rest);

  switch (subcommand) {
    case 'clear': {
      const response = await remoteRequest(baseUrl, '/api/admin/cache/clear', { method: 'POST' }, { token });
      const result = await response.json();

      console.log(`${symbols.success} Cache cleared`);
      break;
    }

    case 'reload': {
      const response = await remoteRequest(baseUrl, '/api/admin/cache/reload', { method: 'POST' }, { token });
      const result = await response.json();

      console.log(`${symbols.success} Configuration reloaded from disk`);
      break;
    }

    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

export default async function admin(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }

  try {
    switch (subcommand) {
      case 'users':
        await usersCommand(rest);
        break;
      case 'groups':
        await groupsCommand(rest);
        break;
      case 'config':
        await configCommand(rest);
        break;
      case 'cache':
        await cacheCommand(rest);
        break;
      default:
        console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
        console.error(`  Run ${c.cyan('ihub admin --help')} for usage`);
        process.exit(1);
    }
  } catch (error) {
    console.error('');
    console.error(`${symbols.error} Command failed: ${error.message}`);
    if (error.status === 401) {
      console.error(`  Authentication required. Run: ${c.cyan('ihub auth login')}`);
    } else if (error.status === 403) {
      console.error(`  Permission denied. Admin access required.`);
    }
    process.exit(1);
  }
}
