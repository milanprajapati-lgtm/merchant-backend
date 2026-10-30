import { UserRole } from '../users/user.entity';

/** The authenticated principal attached to the request by JwtStrategy. */
export interface RequestUser {
  id: string;
  role: UserRole;
  email: string;
}
