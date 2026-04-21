const LoadingIndicator = () => {
  return (
    <div className="flex items-center gap-1.5" aria-busy="true" aria-label="Loading">
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-500 animate-bounce [animation-delay:0ms]" />
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-500 animate-bounce [animation-delay:150ms]" />
      <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-500 animate-bounce [animation-delay:300ms]" />
    </div>
  );
};

export default LoadingIndicator;
