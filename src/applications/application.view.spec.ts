import { RequestUser } from '../common/request-user';
import { UserRole } from '../users/user.entity';
import { MerchantApplication } from './merchant-application.entity';
import { presentApplication, presentPage } from './application.view';

const app = { id: 'a1', riskStatus: 'FLAGGED', riskResult: { reasons: ['WATCHLIST_MATCH'] } } as unknown as MerchantApplication;
const as = (role: UserRole): RequestUser => ({ id: 'u1', role, email: 'u@example.test' });

describe('application view', () => {
  it('hides the detailed risk result from SALES but keeps the risk status', () => {
    const view = presentApplication(app, as(UserRole.SALES));
    expect(view.riskResult).toBeNull();
    expect(view.riskStatus).toBe('FLAGGED');
  });

  it.each([UserRole.ADMIN, UserRole.REVIEWER])('shows the risk result to %s', (role) => {
    expect(presentApplication(app, as(role)).riskResult).toEqual({ reasons: ['WATCHLIST_MATCH'] });
  });

  it('does not mutate the stored entity', () => {
    presentApplication(app, as(UserRole.SALES));
    expect(app.riskResult).not.toBeNull();
  });

  it('applies the same rule to every item of a page and keeps the paging fields', () => {
    const page = presentPage({ items: [app, app], page: 1, total: 2 }, as(UserRole.SALES));
    expect(page.items.map((i) => i.riskResult)).toEqual([null, null]);
    expect(page).toMatchObject({ page: 1, total: 2 });
  });
});
