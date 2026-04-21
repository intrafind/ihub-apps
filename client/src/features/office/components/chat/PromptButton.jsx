const PromptButton = ({ label, subtitle, onClick, disabled = false }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={subtitle ? `${label}\n${subtitle}` : label}
      className="w-full max-w-sm rounded-xl min-w-0 border border-slate-300 bg-[#f5f5f5] hover:bg-white transition-colors text-left px-4 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span className="block min-w-0">
        <span className="block line-clamp-2 text-sm text-slate-800">{label}</span>
        {subtitle ? (
          <span className="block mt-1 text-xs text-slate-600 line-clamp-2">{subtitle}</span>
        ) : null}
      </span>
    </button>
  );
};

export default PromptButton;
