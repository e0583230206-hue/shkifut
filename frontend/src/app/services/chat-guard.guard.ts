import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const AuthGuard: CanActivateFn = async (route, state) => {
  const router = inject(Router);
  const authService = inject(AuthService);

  try {
    let userInfo = await authService.loadUserInfo();
    if (userInfo) return true;
  } catch (err: any) {
    if (err.status === 401) {
      router.navigate(['/login']);
      return false;
    }
    return true;
  }

  return false;
};
