export function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold text-text">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="6" className="fill-accent" />
        <circle cx="7" cy="12" r="2.2" fill="white" />
        <circle cx="17" cy="7" r="2.2" fill="white" />
        <circle cx="17" cy="17" r="2.2" fill="white" />
        <path d="M9 11.2 15 7.8M9 12.8l6 3.4" stroke="white" strokeWidth="1.6" />
      </svg>
      AgentFlow
    </span>
  );
}
