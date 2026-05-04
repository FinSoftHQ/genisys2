import type { BoardEntity, BoardSuiteWithBoards, BoardTemplate } from '@repo/shared';

export type HomeSectionId = 'quick-actions' | 'browse' | 'uuid-fallback';

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
  },
} as const;
