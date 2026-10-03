// Optional browser support: the same actions used by the visible forms.
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<unknown>;
};
type ModelContext = {
  registerTool: (tool: Tool, options?: { signal: AbortSignal }) => void | Promise<void>;
};

export function registerBrowserTools(actions: {
  directory: (url: string) => Promise<unknown>;
  search: (query: string) => Promise<unknown>;
  inspect: (url: string) => Promise<unknown>;
}) {
  const context = (document as Document & { modelContext?: ModelContext }).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const tools = [
    {
      name: 'find_github_directory',
      title: 'Find GitHub directory',
      key: 'url',
      description:
        'Load a GitHub repository, folder, or file into the visible directory browser. Returns file count and size. Prepares a ZIP download but does not start one.',
      execute: actions.directory,
    },
    {
      name: 'search_github_repositories',
      title: 'Search GitHub repositories',
      key: 'query',
      description:
        'Search GitHub and show the first page of repository results. Supports GitHub search qualifiers.',
      execute: actions.search,
    },
    {
      name: 'inspect_github_repository',
      title: 'Inspect GitHub repository',
      key: 'url',
      description:
        'Load the file tree and metadata for a GitHub repository or directory into the explorer. Does not fetch source files or count lines.',
      execute: actions.inspect,
    },
  ];
  for (const tool of tools) {
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: {
              type: 'object',
              properties: { [tool.key]: { type: 'string', minLength: 1, maxLength: 2048 } },
              required: [tool.key],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            async execute(input: unknown) {
              if (!input || typeof input !== 'object' || Array.isArray(input))
                throw new Error('Expected an input object.');
              const record = input as Record<string, unknown>;
              const value = record[tool.key];
              if (
                Object.keys(record).some((key) => key !== tool.key) ||
                typeof value !== 'string' ||
                !value.trim() ||
                value.length > 2048
              )
                throw new Error(`Provide a non-empty ${tool.key} string, up to 2048 characters.`);
              return tool.execute(value.trim());
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {
        /* Optional API must not break the website. */
      });
    } catch {
      /* Unsupported browsers keep the regular UI. */
    }
  }
}
