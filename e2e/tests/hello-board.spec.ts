import { expect } from '@playwright/test';
import { test } from '../fixtures';

test.describe('Hello Board MVP', () => {
  test('board renders from snapshot', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);

    await expect(page.getByRole('heading', { name: 'E2E Board' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'In Progress' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
  });

  test('create card persists and appears without full reload', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();

    const backlogColumn = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Backlog' }) })
      .first();
    await backlogColumn.getByRole('button').first().click();

    const modal = page.getByRole('dialog').filter({ hasText: 'Create Card' });
    await expect(modal).toBeVisible();

    await modal.getByPlaceholder('Card title').fill('New Task');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(modal).not.toBeVisible();
    await expect(page.getByText('New Task')).toBeVisible();
  });

  test('refresh preserves created card', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();

    const backlogColumn = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Backlog' }) })
      .first();
    await backlogColumn.getByRole('button').first().click();

    const modal = page.getByRole('dialog').filter({ hasText: 'Create Card' });
    await modal.getByPlaceholder('Card title').fill('Persistent Card');
    await modal.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Persistent Card')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Persistent Card')).toBeVisible();
  });

  test('edit card title and description persists', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();

    const backlogColumn = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Backlog' }) })
      .first();
    await backlogColumn.getByRole('button').first().click();

    const createModal = page.getByRole('dialog').filter({ hasText: 'Create Card' });
    await createModal.getByPlaceholder('Card title').fill('Editable Card');
    await createModal.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Editable Card')).toBeVisible();

    const card = page
      .locator('div')
      .filter({ has: page.getByText('Editable Card') })
      .filter({ has: page.getByRole('button') })
      .filter({ hasNot: page.getByRole('heading') })
      .first();
    await card.getByRole('button').first().click();

    const editModal = page.getByRole('dialog').filter({ hasText: 'Edit Card' });
    await expect(editModal).toBeVisible();

    await editModal.getByPlaceholder('Card title').fill('Updated Title');
    await editModal.getByPlaceholder('Optional description').fill('Updated description');
    await editModal.getByRole('button', { name: 'Save' }).click();

    await expect(editModal).not.toBeVisible();
    await expect(page.getByText('Updated Title')).toBeVisible();
    await expect(page.getByText('Updated description')).toBeVisible();
  });

  test('drag card from Backlog to In Progress and refresh to confirm persistence', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();

    const backlogColumn = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Backlog' }) })
      .first();
    await backlogColumn.getByRole('button').first().click();

    const modal = page.getByRole('dialog').filter({ hasText: 'Create Card' });
    await modal.getByPlaceholder('Card title').fill('Draggable Card');
    await modal.getByRole('button', { name: 'Create' }).click();

    const card = page
      .locator('div')
      .filter({ has: page.getByText('Draggable Card') })
      .filter({ has: page.getByRole('button') })
      .filter({ hasNot: page.getByRole('heading') })
      .first();
    const inProgressColumn = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'In Progress' }) })
      .first();

    await card.dragTo(inProgressColumn);
    await expect(inProgressColumn.filter({ hasText: 'Draggable Card' })).toBeVisible();

    await page.reload();
    await expect(inProgressColumn.filter({ hasText: 'Draggable Card' })).toBeVisible();
  });

  test('invalid form input shows validation feedback', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();

    const backlogColumn = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Backlog' }) })
      .first();
    await backlogColumn.getByRole('button').first().click();

    const modal = page.getByRole('dialog').filter({ hasText: 'Create Card' });
    await modal.getByPlaceholder('Card title').fill('');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(modal).toBeVisible();
    await expect(modal.getByText('Title is required')).toBeVisible();
  });

  test('API failure surfaces visible error and recovers cleanly', async ({ page, boardId }) => {
    await page.goto(`/boards/${boardId}`);
    await expect(page.getByRole('heading', { name: 'E2E Board' })).toBeVisible();

    const abortHandler = (route: any) => route.abort('internetdisconnected');
    await page.route('**/api/boards/*/snapshot', abortHandler);

    await page.reload();
    await expect(page.getByText(/Failed to load board/)).toBeVisible();

    await page.unrouteAll();
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByRole('heading', { name: 'E2E Board' })).toBeVisible();
  });
});
