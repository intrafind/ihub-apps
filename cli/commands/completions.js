/**
 * ihub completions — Generate shell completion scripts
 * Usage: ihub completions <shell>
 */
import { c, symbols } from '../utils/colors.js';

const HELP = `
  ${c.bold('ihub completions')} — Generate shell completion scripts

  ${c.bold('Usage:')}
    ihub completions <shell>

  ${c.bold('Supported shells:')}
    bash         Bash completions
    zsh          Zsh completions
    fish         Fish shell completions
    powershell   PowerShell tab completions

  ${c.bold('Installation:')}
    Bash:         ihub completions bash >> ~/.bashrc
    Zsh:          ihub completions zsh >> ~/.zshrc  (requires compinit)
    Fish:         ihub completions fish > ~/.config/fish/completions/ihub.fish
    PowerShell:   ihub completions powershell >> $PROFILE
`;

const COMMANDS = [
  'start', 'stop', 'status', 'doctor', 'open', 'setup', 'update',
  'apps', 'models', 'config', 'logs', 'backup', 'restore', 'completions'
];

const SUBCOMMANDS = {
  apps: ['list', 'add', 'enable', 'disable'],
  models: ['list', 'add', 'test'],
  config: ['show', 'edit', 'reset'],
  completions: ['bash', 'zsh', 'fish', 'powershell']
};

function bashCompletions() {
  return `# ihub bash completions
# Add to ~/.bashrc: ihub completions bash >> ~/.bashrc

_ihub_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  }

  local commands="${COMMANDS.join(' ')}"

  case "\${prev}" in
    ihub)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      return 0
      ;;
    apps)
      COMPREPLY=( $(compgen -W "list add enable disable" -- "\${cur}") )
      return 0
      ;;
    models)
      COMPREPLY=( $(compgen -W "list add test" -- "\${cur}") )
      return 0
      ;;
    config)
      COMPREPLY=( $(compgen -W "show edit reset" -- "\${cur}") )
      return 0
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "\${cur}") )
      return 0
      ;;
    restore)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
    --port|-p)
      COMPREPLY=( $(compgen -W "3000 8080 8000" -- "\${cur}") )
      return 0
      ;;
  esac

  # Handle flags
  if [[ "\${cur}" == --* ]]; then
    COMPREPLY=( $(compgen -W "--help --version --port --host --json --daemon --force --no-confirm" -- "\${cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
}

complete -F _ihub_completions ihub
`;
}

function zshCompletions() {
  const commandList = COMMANDS.map(cmd => {
    const subs = SUBCOMMANDS[cmd];
    const desc = {
      start: 'Start the server',
      stop: 'Stop the server',
      status: 'Show server status',
      doctor: 'Diagnose configuration',
      open: 'Open in browser',
      setup: 'Interactive setup wizard',
      update: 'Self-update',
      apps: 'Manage apps',
      models: 'Manage models',
      config: 'Manage configuration',
      logs: 'Stream server logs',
      backup: 'Backup contents directory',
      restore: 'Restore from backup',
      completions: 'Generate shell completions'
    }[cmd] || cmd;
    return `    '${cmd}:${desc}'`;
  }).join('\n');

  return `#compdef ihub
# ihub zsh completions
# Add to ~/.zshrc: ihub completions zsh >> ~/.zshrc

_ihub() {
  local state

  _arguments \\
    '1: :->command' \\
    '2: :->subcommand' \\
    '--help[Show help]' \\
    '--version[Show version]' \\
    '--port[Server port]:port:(3000 8080 8000)' \\
    '--host[Server host]:host:' \\
    '--json[Output as JSON]' \\
    '--daemon[Run in background]' \\
    '--force[Force operation]'

  case \$state in
    command)
      local commands
      commands=(
${commandList}
      )
      _describe 'command' commands
      ;;
    subcommand)
      case \${words[2]} in
        apps)
          local subcmds=('list:List apps' 'add:Add an app' 'enable:Enable an app' 'disable:Disable an app')
          _describe 'subcommand' subcmds
          ;;
        models)
          local subcmds=('list:List models' 'add:Add a model' 'test:Test connectivity')
          _describe 'subcommand' subcmds
          ;;
        config)
          local subcmds=('show:Show config' 'edit:Edit config' 'reset:Reset to defaults')
          _describe 'subcommand' subcmds
          ;;
        completions)
          local shells=('bash' 'zsh' 'fish' 'powershell')
          _describe 'shell' shells
          ;;
        restore)
          _files
          ;;
      esac
      ;;
  esac
}

_ihub "$@"
`;
}

function fishCompletions() {
  const cmdCompletions = COMMANDS.map(cmd => {
    const desc = {
      start: 'Start the server',
      stop: 'Stop the server',
      status: 'Show server status',
      doctor: 'Diagnose configuration',
      open: 'Open in browser',
      setup: 'Interactive setup wizard',
      update: 'Self-update',
      apps: 'Manage apps',
      models: 'Manage models',
      config: 'Manage configuration',
      logs: 'Stream server logs',
      backup: 'Backup contents directory',
      restore: 'Restore from backup',
      completions: 'Generate shell completions'
    }[cmd] || cmd;
    return `complete -c ihub -f -n '__fish_use_subcommand' -a ${cmd} -d '${desc}'`;
  }).join('\n');

  const subCompletions = Object.entries(SUBCOMMANDS).map(([cmd, subs]) => {
    return subs.map(sub => {
      return `complete -c ihub -f -n '__fish_seen_subcommand_from ${cmd}' -a ${sub}`;
    }).join('\n');
  }).join('\n');

  return `# ihub fish completions
# Install: ihub completions fish > ~/.config/fish/completions/ihub.fish

function __fish_use_subcommand
  set cmd (commandline -opc)
  if test (count $cmd) -eq 1
    return 0
  end
  return 1
end

${cmdCompletions}

${subCompletions}

# Flags
complete -c ihub -l help -d 'Show help'
complete -c ihub -l version -d 'Show version'
complete -c ihub -l port -d 'Server port' -r
complete -c ihub -l host -d 'Server host' -r
complete -c ihub -l json -d 'Output as JSON'
complete -c ihub -l daemon -d 'Run in background'
complete -c ihub -l force -d 'Force operation'
complete -c ihub -l no-confirm -d 'Skip confirmation'
`;
}

function powershellCompletions() {
  const commandList = COMMANDS.map(c => `'${c}'`).join(', ');

  return `# ihub PowerShell completions
# Add to $PROFILE: ihub completions powershell >> $PROFILE

Register-ArgumentCompleter -Native -CommandName 'ihub' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @(${commandList})
  $subCommands = @{
    'apps'        = @('list', 'add', 'enable', 'disable')
    'models'      = @('list', 'add', 'test')
    'config'      = @('show', 'edit', 'reset')
    'completions' = @('bash', 'zsh', 'fish', 'powershell')
  }

  $tokens = $commandAst.CommandElements
  $prevToken = if ($tokens.Count -gt 1) { $tokens[$tokens.Count - 2].Value } else { '' }

  if ($subCommands.ContainsKey($prevToken)) {
    $subCommands[$prevToken] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  } else {
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}
`;
}

export default async function completions(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    if (!args.length) {
      console.error(`${symbols.error} Specify a shell: bash, zsh, fish, or powershell`);
      process.exit(1);
    }
    return;
  }

  const shell = args[0].toLowerCase();

  switch (shell) {
    case 'bash':
      process.stdout.write(bashCompletions());
      break;
    case 'zsh':
      process.stdout.write(zshCompletions());
      break;
    case 'fish':
      process.stdout.write(fishCompletions());
      break;
    case 'powershell':
    case 'ps':
    case 'pwsh':
      process.stdout.write(powershellCompletions());
      break;
    default:
      console.error(`${symbols.error} Unknown shell: ${shell}`);
      console.error(`  Supported: bash, zsh, fish, powershell`);
      process.exit(1);
  }
}
