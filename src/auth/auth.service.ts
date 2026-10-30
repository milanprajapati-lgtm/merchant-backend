import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';

export const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  // Compared against when the email is unknown so response time does not reveal which emails exist.
  private readonly timingEqualizerHash = bcrypt.hashSync('timing-equalizer', BCRYPT_ROUNDS);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.usersService.findByEmailForLogin(email);
    const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? this.timingEqualizerHash);
    if (!user || !passwordOk) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Only the subject goes in the token; role is re-read from the database on every request.
    const accessToken = await this.jwtService.signAsync({ sub: user.id });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '1h'),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
