import { ApplicationPolicy } from './application.policy';
import { RequestUser } from '../common/request-user';
import { UserRole } from '../users/user.entity';

const user = (id: string, role: UserRole): RequestUser => ({ id, role, email: `${id}@example.test` });
const app = { createdById: 'sales-a', assignedReviewerId: 'rev-1' as string | null };

describe('ApplicationPolicy (object-level authorization)', () => {
  describe('canView', () => {
    it('ADMIN sees everything', () => expect(ApplicationPolicy.canView(app, user('x', UserRole.ADMIN))).toBe(true));
    it('SALES sees only own applications', () => {
      expect(ApplicationPolicy.canView(app, user('sales-a', UserRole.SALES))).toBe(true);
      expect(ApplicationPolicy.canView(app, user('sales-b', UserRole.SALES))).toBe(false);
    });
    it('REVIEWER sees only applications assigned to them', () => {
      expect(ApplicationPolicy.canView(app, user('rev-1', UserRole.REVIEWER))).toBe(true);
      expect(ApplicationPolicy.canView(app, user('rev-2', UserRole.REVIEWER))).toBe(false);
      expect(ApplicationPolicy.canView({ ...app, assignedReviewerId: null }, user('rev-1', UserRole.REVIEWER))).toBe(false);
    });
    it('denies unknown roles', () => {
      expect(ApplicationPolicy.canView(app, { id: 'x', role: 'HACKER' as UserRole, email: 'x' })).toBe(false);
    });
  });

  describe('canEdit', () => {
    it('allows ADMIN and the owning SALES user only', () => {
      expect(ApplicationPolicy.canEdit(app, user('x', UserRole.ADMIN))).toBe(true);
      expect(ApplicationPolicy.canEdit(app, user('sales-a', UserRole.SALES))).toBe(true);
      expect(ApplicationPolicy.canEdit(app, user('sales-b', UserRole.SALES))).toBe(false);
      expect(ApplicationPolicy.canEdit(app, user('rev-1', UserRole.REVIEWER))).toBe(false);
    });
  });

  describe('canDecide', () => {
    it('allows only the assigned REVIEWER', () => {
      expect(ApplicationPolicy.canDecide(app, user('rev-1', UserRole.REVIEWER))).toBe(true);
      expect(ApplicationPolicy.canDecide(app, user('rev-2', UserRole.REVIEWER))).toBe(false);
    });
    it('does not allow ADMIN or SALES, even the owner', () => {
      expect(ApplicationPolicy.canDecide(app, user('x', UserRole.ADMIN))).toBe(false);
      expect(ApplicationPolicy.canDecide(app, user('sales-a', UserRole.SALES))).toBe(false);
    });
    it('does not match when nobody is assigned', () => {
      expect(ApplicationPolicy.canDecide({ ...app, assignedReviewerId: null }, user('rev-1', UserRole.REVIEWER))).toBe(false);
    });
  });
});
