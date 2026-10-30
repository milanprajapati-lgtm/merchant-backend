import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from './user.entity';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  findByEmailForLogin(email: string) {
    return this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: email.trim().toLowerCase() })
      .andWhere('user.isActive = :active', { active: true })
      .getOne();
  }

  findById(id: string) {
    return this.users.findOne({ where: { id, isActive: true } });
  }

  /** Used to validate reviewer assignment: the target must exist, be active and hold the REVIEWER role. */
  findActiveReviewer(id: string) {
    return this.users.findOne({ where: { id, role: UserRole.REVIEWER, isActive: true } });
  }
}
