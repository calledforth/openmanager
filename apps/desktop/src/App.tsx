import React, { useState } from 'react';
import {
  CaretDownIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PaperclipIcon,
  WarningIcon,
  ArrowUpIcon,
  NotePencilIcon,
  FileTextIcon,
  TerminalIcon,
  CheckCircleIcon,
  FileCodeIcon,
  HashIcon,
  AtomIcon,
  SidebarSimpleIcon,
  PushPinIcon,
  GitBranchIcon,
  ChatCircleIcon,
  GridFourIcon,
  UserPlusIcon,
  PlusIcon,
  ListChecksIcon,
  CircleNotchIcon,
  MicroscopeIcon,
  BugIcon,
  GraduationCapIcon,
  SparkleIcon,
  FolderIcon,
  FolderOpenIcon,
} from '@phosphor-icons/react';

const CustomDropdown = ({ options, value, onChange }: { options: {label: string, value: string}[], value: string, onChange: (val: string) => void }) => {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <div className="relative">
      <button 
        onClick={() => setIsOpen(!isOpen)} 
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-200 bg-transparent hover:bg-white/5 border border-transparent hover:border-white/5 rounded-md transition-all"
      >
        {options.find(o => o.value === value)?.label}
        <CaretDownIcon size={12} className="text-neutral-500" />
      </button>
      {isOpen && (
        <div className="absolute bottom-full mb-1 left-0 w-48 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-2xl overflow-hidden z-50 py-1">
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setIsOpen(false); }}
              className={`w-full text-left px-3 py-2 text-[12px] font-medium transition-colors ${value === opt.value ? 'bg-white/10 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const LogEntry = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[13px] text-neutral-500 py-1 hover:shimmer-effect w-fit cursor-default transition-all">{children}</div>
);

const FileReadLog = ({ filename, lines }: { filename: string, lines?: number }) => (
  <LogEntry>Reading file: <span className="text-neutral-300 hover:text-orange-400 cursor-pointer transition-colors font-mono">{filename}</span>{lines ? ` (${lines} lines)` : ''}</LogEntry>
);

const FileEditBlock = ({ icon: Icon, filename, added, removed }: { icon: any, filename: string, added?: string, removed?: string }) => (
  <div className="flex items-center gap-3 bg-white/[0.02] border border-white/5 rounded-md px-2.5 py-1.5 my-0.5 w-full max-w-3xl hover:shimmer-effect hover:border-white/10 transition-all cursor-default">
    <Icon size={13} className="text-white" />
    <span className="text-[12px] text-white hover:text-orange-400 cursor-pointer font-mono transition-colors">{filename}</span>
    <div className="flex gap-3 ml-auto text-[12px] font-mono">
      {added && <span className="text-green-500">+{added}</span>}
      {removed && <span className="text-red-500">-{removed}</span>}
    </div>
  </div>
);

const TodoItem = ({ text, done }: { text: string, done?: boolean }) => (
  <div className="flex items-start gap-2 px-2 py-1.5 hover:bg-white/5 rounded group cursor-default">
    <div className="mt-0.5">
      {done ? (
        <CheckCircleIcon size={14} className="text-orange-500" />
      ) : (
        <div className="w-[14px] h-[14px] rounded-full border border-neutral-600 group-hover:border-orange-500 transition-colors" />
      )}
    </div>
    <span className={`text-[12px] ${done ? 'text-neutral-500 line-through' : 'text-neutral-300'}`}>
      {text}
    </span>
  </div>
);

const ActionHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="text-[13px] font-medium text-neutral-300 mt-4 mb-1.5 hover:shimmer-effect w-fit cursor-default transition-all">{children}</div>
);

const UserMessage = ({ initialText }: { initialText: string }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(initialText);

  if (isEditing) {
    return (
      <div className="mb-8 w-full">
        <div className="bg-[#0a0a0a] border border-white/10 rounded p-3 shadow-2xl flex flex-col gap-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full bg-transparent resize-none outline-none text-neutral-200 min-h-[44px] text-[15px] leading-relaxed p-1"
            rows={3}
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-1">
            <button onClick={() => setIsEditing(false)} className="px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-200 transition-colors">Cancel</button>
            <button onClick={() => setIsEditing(false)} className="px-3 py-1.5 text-xs font-medium bg-white text-black rounded-sm hover:bg-neutral-200 transition-colors">Save</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      onClick={() => setIsEditing(true)}
      className="mb-8 w-full p-4 border border-white/10 bg-white/[0.03] shadow-2xl rounded transition-all cursor-text group relative"
    >
      <div className="text-neutral-200 text-[15px] leading-relaxed">
        {text}
      </div>
    </div>
  );
};

export default function App() {
  const [inputValue, setInputValue] = useState('');
  const [fontClass, setFontClass] = useState('font-geist');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isTodosOpen, setIsTodosOpen] = useState(true);
  const [model, setModel] = useState('flash-lite');
  const [thinkingMode, setThinkingMode] = useState('auto');
  const [mode, setMode] = useState('build');
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [openWorkspaces, setOpenWorkspaces] = useState<Record<string, boolean>>({'openmanager': true});

  const toggleWorkspace = (id: string) => {
    setOpenWorkspaces(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const workspacesData = [
    { id: '1', name: 'Research_Schizoprenia', icon: MicroscopeIcon, sessions: [
      { id: 'r1', title: 'Literature review on dopamine...' },
      { id: 'r2', title: 'Data analysis script for fMRI' },
    ] },
    { id: '2', name: 'blocker', icon: BugIcon, sessions: [
      { id: 'b1', title: 'Fixing CORS issue in prod' },
      { id: 'b2', title: 'Database migration script' },
    ] },
    { id: '3', name: 'finalyr_proj', icon: GraduationCapIcon, sessions: [
      { id: 'f1', title: 'Drafting the abstract' },
      { id: 'f2', title: 'System architecture diagram' },
    ] },
    { id: '4', name: 'ayumi', icon: SparkleIcon, sessions: [
      { id: 'a1', title: 'Character backstory ideas' },
      { id: 'a2', title: 'Dialogue tree generation' },
    ] },
    { id: '5', name: 'openmanager', icon: TerminalIcon, sessions: [
      { id: 's1', title: 'Light chat with friend' },
      { id: 's2', title: 'Repo review request and fee...', isActive: true, isLoading: true },
      { id: 's3', title: 'Light chat greeting conversa...' },
      { id: 's4', title: 'Light chat with son greeting' },
      { id: 's5', title: 'Greeting check-in conversati...' },
      { id: 's6', title: 'Directory scan: .tmp, t3code; ...' },
      { id: 's7', title: 'Reading a file for results req...' },
      { id: 's8', title: 'Improve chat UI input box a...' },
      { id: 's9', title: 'Quick folder contents check ...' },
      { id: 's10', title: 'Greeting — quick check-in' },
      { id: 's11', title: 'Hey how u doing, folders are...' },
      { id: 's12', title: 'Can you try using a subagen...' },
      { id: 's13', title: 'can u try using glob, to acce...' },
      { id: 's14', title: 'Session title bug (placeholde...' },
      { id: 's15', title: 'hey' },
    ]}
  ];

  const activeSession = workspacesData.flatMap(ws => ws.sessions).find(s => s.isActive);
  const sessionTitle = activeSession ? activeSession.title : "New Session";

  const modelOptions = [
    { value: 'flash-lite', label: 'Gemini 2.5 Flash Lite' },
    { value: 'flash', label: 'Gemini 2.5 Flash' },
    { value: 'pro', label: 'Gemini 2.5 Pro' },
    { value: 'thinking', label: 'Gemini 3.0 Thinking' },
  ];

  const thinkingOptions = [
    { value: 'auto', label: 'Auto Thinking' },
    { value: 'fast', label: 'Fast Thinking' },
    { value: 'deep', label: 'Deep Thinking' },
  ];

  return (
    <div className={`h-screen w-full bg-[#0a0a0a] text-[#e0e0e0] ${fontClass} flex flex-row selection:bg-[#333] selection:text-white`}>
      
      {/* Sidebar */}
      <div className={`transition-all duration-300 ease-in-out flex flex-col h-full shrink-0 ${isSidebarOpen ? 'w-[260px] opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}>
        <div className="w-[260px] h-full flex flex-col bg-transparent py-2">
          {/* Header / Toggle */}
          <div className="flex items-center justify-between px-4 pt-2 pb-1">
            <button onClick={() => setIsSidebarOpen(false)} className="text-neutral-500 hover:text-neutral-200 transition-colors">
              <SidebarSimpleIcon size={16} />
            </button>
            <button className="text-neutral-500 hover:text-neutral-200 transition-colors">
              <NotePencilIcon size={14} />
            </button>
          </div>

          {/* MagnifyingGlassIcon */}
          <div className="px-3 mb-3 mt-4 relative flex items-center">
            <MagnifyingGlassIcon size={14} className="absolute left-5 text-neutral-500" />
            <input 
              type="text" 
              placeholder="MagnifyingGlassIcon your threads..." 
              className="w-full bg-transparent border-none text-[13px] text-neutral-300 placeholder:text-neutral-500 pl-8 py-1 outline-none" 
            />
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto custom-scrollbar px-2 text-[13px]">
            {workspacesData.map(ws => (
              <div key={ws.id} className="mb-0.5">
                <div 
                  onClick={() => toggleWorkspace(ws.id)}
                  className="flex items-center gap-2 text-[13px] text-neutral-300 hover:text-white font-medium px-2 py-0.5 cursor-pointer transition-colors select-none group"
                >
                  <ws.icon size={14} className={`transition-colors ${openWorkspaces[ws.id] ? 'text-orange-500' : 'text-neutral-500 group-hover:text-orange-400'}`} />
                  {ws.name}
                </div>
                
                {openWorkspaces[ws.id] && (
                  <div className="mt-0.5 mb-1 flex flex-col gap-0.5">
                    <div className="px-2 py-0.5 mx-1 hover:bg-white/5 rounded-md cursor-pointer flex items-center gap-2 text-neutral-500 hover:text-orange-400 transition-colors text-[12px] group">
                      <PlusIcon size={12} className="shrink-0 group-hover:rotate-90 transition-transform duration-300" /> New session
                    </div>
                    {ws.sessions.map(session => (
                      <div 
                        key={session.id} 
                        className={`px-2 py-0.5 mx-1 rounded-md cursor-pointer flex items-center gap-2 transition-all group ${
                          session.isActive 
                            ? 'bg-orange-500/10 text-orange-50' 
                            : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
                        }`}
                      >
                        {session.isLoading ? (
                          <CircleNotchIcon size={12} className="text-orange-500 shrink-0 animate-spin" />
                        ) : (
                          <ChatCircleIcon size={12} className={`${session.isActive ? 'text-orange-500' : 'text-neutral-600 group-hover:text-orange-400/50'} shrink-0 transition-colors`} /> 
                        )}
                        <span className="truncate text-[12px]">{session.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Bottom Actions */}
          <div className="px-3 py-2 mt-auto">
            <button className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] font-medium text-neutral-400 hover:text-neutral-200 hover:bg-white/5 rounded-md transition-colors">
              <FolderOpenIcon size={14} className="text-neutral-500" />
              Open FolderIcon
            </button>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className={`flex-1 h-full pt-2 pr-2 pb-0 ${isSidebarOpen ? 'pl-0' : 'pl-2'} transition-all duration-300`}>
        <div className="relative w-full h-full border border-neutral-800 border-b-0 rounded-t-xl rounded-b-none overflow-hidden bg-[#050505] shadow-2xl flex flex-col transition-all duration-500">
        
        {/* Top Header */}
        <div className="absolute top-0 left-0 right-0 h-14 z-20 flex items-center px-4 bg-gradient-to-b from-[#050505] to-transparent">
          <div className="flex items-center gap-3">
            {!isSidebarOpen && (
              <button onClick={() => setIsSidebarOpen(true)} className="text-neutral-500 hover:text-neutral-200 transition-all hover:shimmer-effect p-1.5 rounded hover:bg-white/5 bg-black/20 border border-white/5">
                <SidebarSimpleIcon size={16} />
              </button>
            )}
            <div className="text-[14px] font-medium text-neutral-200">
              {sessionTitle}
            </div>
          </div>
        </div>

        {/* Scrollable Chat Area */}
        <div className="absolute inset-0 overflow-y-auto w-full px-4 pt-16 pb-40 scroll-smooth custom-scrollbar z-10">
          <div className="max-w-3xl mx-auto">
            
            <UserMessage initialText="I need to make some simple changes. I've attached some image. Look at the two calls, and you need to simulate exactly those calls for each message..." />

            <div className="mb-8 px-4">
              <div 
                onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                className="text-[13px] text-neutral-500 py-1 hover:text-neutral-300 w-fit cursor-pointer transition-all flex items-center gap-2 select-none"
              >
                <CaretDownIcon size={14} className={`transition-transform duration-200 ${isThinkingExpanded ? '' : '-rotate-90'}`} />
                Thinking Process (12.4s)
              </div>
              
              <div className={`overflow-hidden transition-all duration-300 ${isThinkingExpanded ? 'max-h-[1000px] opacity-100 mt-2 mb-4' : 'max-h-0 opacity-0 mb-0'}`}>
                <div className="pl-4 border-l border-white/10 ml-1.5 space-y-0.5">
                  <LogEntry>Analyzing user request for UI modifications</LogEntry>
                  <LogEntry>Identifying target components: Dropdown, Send Button, LogEntries</LogEntry>
                  <LogEntry>Planning custom dropdown implementation to replace native select</LogEntry>
                  <LogEntry>Thought for 1.2s</LogEntry>
                </div>
              </div>

              <div className="space-y-0.5 mt-2">
                <LogEntry>Executing command: <span className="font-mono text-neutral-400">grep -rI "select" src/</span></LogEntry>
                <LogEntry>Found 2 matches in <span className="font-mono text-neutral-400">src/App.tsx</span></LogEntry>
                <FileReadLog filename="/src/App.tsx" lines={337} />
                <FileEditBlock icon={FileCodeIcon} filename="vite.config.js" added="2" removed="2" />
                <FileEditBlock icon={HashIcon} filename="index.css" added="73" />
                <FileReadLog filename="/src/index.css" lines={142} />
                <FileEditBlock icon={HashIcon} filename="index.css" added="75" />

                <ActionHeader>Now let me build all 5 chat variations:</ActionHeader>
                <FileEditBlock icon={FileCodeIcon} filename="messages.js" added="180" />

                <ActionHeader>Now let me build the 5 chat variations:</ActionHeader>
                <FileEditBlock icon={AtomIcon} filename="V1Terminal.jsx" added="176" />
                <FileEditBlock icon={AtomIcon} filename="V2Clean.jsx" added="167" />
                <FileEditBlock icon={AtomIcon} filename="V3Cards.jsx" added="187" />

                <FileReadLog filename="/package.json" />
                <LogEntry>Found files matching <span className="font-mono text-neutral-400">src/**/*</span></LogEntry>
                <FileReadLog filename="/src/App.jsx" />
                <FileReadLog filename="/src/messages.js" />
                <FileReadLog filename="/src/V1Terminal.jsx" />
                <FileReadLog filename="/src/index.css" />
                <FileReadLog filename="/src/V2Clean.jsx" />
                <FileReadLog filename="/src/V3Cards.jsx" />
              </div>
            </div>

            {/* AI Content */}
            <div className="text-[15px] leading-[1.75] space-y-6 text-neutral-300 px-4 pb-8">
              <p>I've completely redesigned the dropdown menus to match the sleek, dark aesthetic of the UI, replacing the native browser selects with custom components.</p>
              
              <p>Here is the implementation for the custom dropdown:</p>
              
              <div className="bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden my-4">
                <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
                  <span className="text-xs font-mono text-neutral-400">CustomDropdown.tsx</span>
                  <span className="text-xs text-neutral-500">typescript</span>
                </div>
                <pre className="p-4 overflow-x-auto text-[13px] font-mono leading-relaxed text-neutral-300">
                  <code dangerouslySetInnerHTML={{ __html: `<span class="text-neutral-500">const</span> <span class="text-neutral-200">CustomDropdown</span> <span class="text-neutral-500">=</span> ({ options, value, onChange }) <span class="text-neutral-500">=&gt;</span> {
  <span class="text-neutral-500">const</span> [isOpen, setIsOpen] <span class="text-neutral-500">=</span> <span class="text-neutral-200">useState</span>(<span class="text-orange-400">false</span>);
  
  <span class="text-neutral-500">return</span> (
    <span class="text-neutral-500">&lt;</span><span class="text-neutral-200">div</span> <span class="text-neutral-400">className</span><span class="text-neutral-500">=</span><span class="text-neutral-400">"relative"</span><span class="text-neutral-500">&gt;</span>
      <span class="text-neutral-500">&lt;</span><span class="text-neutral-200">button</span> 
        <span class="text-neutral-400">onClick</span><span class="text-neutral-500">=</span>{() <span class="text-neutral-500">=&gt;</span> <span class="text-neutral-200">setIsOpen</span>(<span class="text-neutral-500">!</span>isOpen)} 
        <span class="text-neutral-400">className</span><span class="text-neutral-500">=</span><span class="text-neutral-400">"flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-200"</span>
      <span class="text-neutral-500">&gt;</span>
        {options.<span class="text-neutral-200">find</span>(o <span class="text-neutral-500">=&gt;</span> o.value <span class="text-neutral-500">===</span> value)<span class="text-neutral-500">?.</span>label}
        <span class="text-neutral-500">&lt;</span><span class="text-neutral-200">ChevronDown</span> <span class="text-neutral-400">size</span><span class="text-neutral-500">=</span>{<span class="text-orange-400">12</span>} <span class="text-neutral-400">className</span><span class="text-neutral-500">=</span><span class="text-neutral-400">"text-neutral-500"</span> <span class="text-neutral-500">/&gt;</span>
      <span class="text-neutral-500">&lt;/</span><span class="text-neutral-200">button</span><span class="text-neutral-500">&gt;</span>
      <span class="text-neutral-600 italic">{/* Dropdown menu implementation */}</span>
    <span class="text-neutral-500">&lt;/</span><span class="text-neutral-200">div</span><span class="text-neutral-500">&gt;</span>
  );
};` }} />
                </pre>
              </div>

              <p>I also added a flair of <strong className="text-orange-400 font-medium">orange</strong> to the send button when there is active input, and made the file names in the tool calls clickable (hover over them to see the orange effect).</p>
              
              <ul className="list-disc pl-5 space-y-2">
                <li>Native <code className="bg-white/10 px-1.5 py-0.5 rounded text-[13px] font-mono text-orange-400">&lt;select&gt;</code> elements replaced with custom React state.</li>
                <li>Tool calls are now slightly larger and more detailed.</li>
                <li>Markdown code blocks feature syntax highlighting colors (simulated here) and a header.</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Floating Input Area */}
        <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-black via-black/90 to-transparent pt-28 pointer-events-none z-20">
          <div className="max-w-3xl mx-auto relative pointer-events-auto px-4 pb-0">
             
             <div className="flex flex-col shadow-2xl">
                {/* To-Do List */}
                <div className="bg-[#0a0a0a]/95 backdrop-blur-3xl border border-white/10 border-b-0 rounded-t-lg overflow-hidden">
                   <div 
                     onClick={() => setIsTodosOpen(!isTodosOpen)}
                     className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02] cursor-pointer hover:bg-white/[0.04] transition-colors"
                   >
                      <div className="flex items-center gap-2 text-xs font-semibold text-neutral-200">
                         <ListChecksIcon size={14} className="text-neutral-400" /> 6/6 todos completed
                      </div>
                      <CaretDownIcon size={14} className={`text-neutral-500 transition-transform duration-200 ${isTodosOpen ? '' : 'rotate-180'}`} />
                   </div>
                   {isTodosOpen && (
                     <div className="flex flex-col p-1.5 max-h-[160px] overflow-y-auto custom-scrollbar">
                        <TodoItem text="Build V1 TerminalIcon (green-on-black, monospace, hacker terminal)" done />
                        <TodoItem text="Build V2 Clean (minimal dark, violet accents, ChatGPT-like)" done />
                        <TodoItem text="Build V3 Cards (content-in-cards, colorful, travel/rich content)" done />
                        <TodoItem text="Build V4 Paper (light mode, editorial, document-like)" done />
                        <TodoItem text="Build V5 Prose (dark serif, literary, elegant writing mode)" done />
                        <TodoItem text="Wire all 5 variants into App.jsx switcher" done />
                     </div>
                   )}
                </div>

                {/* Input Box */}
                <div className="bg-[#0a0a0a]/95 backdrop-blur-3xl border border-white/10 rounded-b-none p-2.5 flex flex-col gap-2 relative">
                  <textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    className="w-full bg-transparent resize-none outline-none text-neutral-200 placeholder:text-neutral-600 min-h-[36px] max-h-32 text-[13px] leading-relaxed p-1 custom-scrollbar"
                    placeholder="Type your message here..."
                    rows={1}
                  />

                  {/* Bottom Row */}
                  <div className="flex items-center justify-between mt-0.5">
                    {/* Left Controls */}
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                      
                      {/* Attach Button */}
                      <button className="flex items-center justify-center text-neutral-400 hover:text-neutral-200 p-1.5 rounded-md border border-transparent hover:bg-white/10 transition-all">
                        <PlusIcon size={14} />
                      </button>

                      <div className="w-[1px] h-4 bg-white/10 mx-1" />

                      {/* Build/Plan Mode Switcher */}
                      <div className="relative flex items-center bg-black/50 border border-white/5 rounded-md p-0.5">
                        <div 
                          className={`absolute top-0.5 bottom-0.5 w-[46px] rounded-sm transition-all duration-300 ease-out ${mode === 'plan' ? 'translate-x-[46px] bg-orange-500/20' : 'translate-x-0 bg-white/10'}`} 
                        />
                        <button 
                          onClick={() => setMode('build')}
                          className={`relative z-10 w-[46px] py-1 rounded-sm text-[11px] font-medium transition-colors duration-300 ${mode === 'build' ? 'text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
                        >
                          Build
                        </button>
                        <button 
                          onClick={() => setMode('plan')}
                          className={`relative z-10 w-[46px] py-1 rounded-sm text-[11px] font-medium transition-colors duration-300 ${mode === 'plan' ? 'text-orange-400' : 'text-neutral-500 hover:text-neutral-300'}`}
                        >
                          Plan
                        </button>
                      </div>

                      <div className="w-[1px] h-4 bg-white/10 mx-1" />

                      {/* Model Dropdown */}
                      <CustomDropdown options={modelOptions} value={model} onChange={setModel} />

                      {/* Thinking Modes Dropdown */}
                      <CustomDropdown options={thinkingOptions} value={thinkingMode} onChange={setThinkingMode} />

                    </div>

                    {/* Right Controls */}
                    <button
                      className={`p-1.5 rounded-md transition-all shrink-0 ml-2 ${
                        inputValue.trim() 
                          ? mode === 'plan'
                            ? 'bg-orange-500 text-white hover:bg-orange-400'
                            : 'bg-white text-black hover:bg-neutral-200'
                          : 'bg-white/10 text-neutral-500 hover:bg-white/20'
                      }`}
                    >
                      <ArrowUpIcon size={14} />
                    </button>
                  </div>
               </div>
             </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
