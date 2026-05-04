import type { BoardEntity, BoardSuiteWithBoards, BoardTemplate } from '@repo/shared';

export type HomeSectionId = 'quick-actions' | 'browse' | 'uuid-fallback';
export type HomeQuickActionId = 'create-suite' | 'create-board';
export type HomeBrowseGroupId = 'suite-groups' | 'standalone-boards';

export type HomeBoardTemplateOption = Extract<BoardTemplate, 'default' | 'development'>;
export type HomeSuiteTemplateOption = Extract<BoardTemplate, 'default' | 'development'>;

export type HomeCreateBoardFormState = {
  title: string;
  prefix: string;
  template: HomeBoardTemplateOption;
};

export type HomeCreateSuiteFormState = {
  title: string;
  template: HomeSuiteTemplateOption;
};

export type HomeQuickActionsState = {
  suite: HomeCreateSuiteFormState;
  board: HomeCreateBoardFormState;
  isCreatingSuite: boolean;
  isCreatingBoard: boolean;
};

export type HomeBrowseDataState = {
  suites: BoardSuiteWithBoards[];
  standaloneBoards: BoardEntity[];
  allBoards: BoardEntity[];
};

export type HomeBrowseUiState = {
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
};

export type HomeUuidFallbackState = {
  isOpen: boolean;
  boardIdInput: string;
};

export type KanbanHomePageState = {
  sectionOrder: readonly HomeSectionId[];
  quickActionOrder: readonly HomeQuickActionId[];
  browseGroupOrder: readonly HomeBrowseGroupId[];
  quickActions: HomeQuickActionsState;
  browseData: HomeBrowseDataState;
  browseUi: HomeBrowseUiState;
  uuidFallback: HomeUuidFallbackState;
};

export const KANBAN_HOME_SECTION_ORDER: readonly HomeSectionId[] = [
  'quick-actions',
  'browse',
  'uuid-fallback',
] as const;

export const KANBAN_HOME_QUICK_ACTION_ORDER: readonly HomeQuickActionId[] = [
  'create-suite',
  'create-board',
] as const;

export const KANBAN_HOME_BROWSE_GROUP_ORDER: readonly HomeBrowseGroupId[] = [
  'suite-groups',
  'standalone-boards',
] as const;

export const KANBAN_HOME_SECTION_META = {
  'quick-actions': {
    ariaLabel: 'Quick Actions',
    title: 'Quick Actions',
    description: 'Create a suite first, then create standalone boards when needed.',
    aboveFold: true,
  },
  browse: {
    ariaLabel: 'Browse',
    title: 'Browse',
    description: 'Search and open existing suites and boards.',
    aboveFold: true,
  },
  'uuid-fallback': {
    ariaLabel: 'UUID Fallback',
    title: 'UUID Fallback',
    description: 'Advanced access only for direct board ID navigation.',
    aboveFold: false,
  },
} as const;

export const KANBAN_HOME_COMPONENT_CONTRACT = {
  suiteQuickAccessCard: 'HomeSuiteQuickAccessCard',
  boardQuickAccessCard: 'HomeBoardQuickAccessCard',
} as const;

export const KANBAN_HOME_UI_CONSTRAINTS = {
  boardTitle: {
    minLength: 1,
    maxLength: 200,
    trimBeforeSubmit: true,
    fallback: 'New Board',
  },
  suiteTitle: {
    minLength: 1,
    maxLength: 200,
    trimBeforeSubmit: true,
    fallback: 'New Suite',
  },
  templates: {
    allowed: ['default', 'development'] as const,
  },
  boardPrefix: {
    pattern: /^[A-Z][A-Z0-9]{0,9}$/,
    optional: true,
    normalize: 'trim',
  },
  search: {
    normalize: 'trim-lowercase',
    fields: ['board.title', 'board.prefix', 'suite.title'] as const,
  },
  uuidFallback: {
    defaultOpen: false,
    placement: 'last-section',
    primaryUx: false,
  },
  quickActions: {
    primaryCta: 'create-suite',
    secondaryCta: 'create-board',
  },
  visualTone: {
    primaryButtonColor: 'primary',
    secondaryButtonColor: 'neutral',
    destructiveButtonColor: 'error',
    avoidLegacyPalette: true,
  },
} as const;
