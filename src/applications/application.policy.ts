import { RequestUser } from '../common/request-user';
import { UserRole } from '../users/user.entity';
import { MerchantApplication } from './merchant-application.entity';

type Owned = Pick<MerchantApplication, 'createdById' | 'assignedReviewerId'>;

/**
 * Object-level authorization. Every read or write of a single application goes through here
 * (inside the same transaction that loads the row), never just through route-level @Roles.
 *
 *            view                    edit/submit         decide
 *  ADMIN     all                     all                 never (see ADR-001)
 *  SALES     only own (createdBy)    only own            never
 *  REVIEWER  only assigned to them   never               only assigned to them
 */
export const ApplicationPolicy = {
  canView(app: Owned, actor: RequestUser): boolean {
    switch (actor.role) {
      case UserRole.ADMIN:
        return true;
      case UserRole.SALES:
        return app.createdById === actor.id;
      case UserRole.REVIEWER:
        return app.assignedReviewerId === actor.id;
      default:
        return false;
    }
  },

  canEdit(app: Owned, actor: RequestUser): boolean {
    return actor.role === UserRole.ADMIN || (actor.role === UserRole.SALES && app.createdById === actor.id);
  },

  canDecide(app: Owned, actor: RequestUser): boolean {
    return actor.role === UserRole.REVIEWER && app.assignedReviewerId === actor.id;
  },
};
