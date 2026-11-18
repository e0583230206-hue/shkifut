import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterOutlet } from '@angular/router';
import { AppComponent } from './app.component';
import { NotificationsService } from './services/notifications.service';
import { UpdateService } from './services/update.service';
import { AccessibilityService } from './services/accessibility.service';
import { PersonalService } from './services/personal.service';
import { StarredService } from './services/starred.service';
import { WorkNotificationsService } from './services/work-notifications.service';

// Stubs for the child components: the real ones need HTTP, the router and the login state. This spec tests AppComponent only.
@Component({ selector: 'app-staff-chat', template: '' })
class StaffChatStub {}
@Component({ selector: 'app-update-banner', template: '' })
class UpdateBannerStub {}
@Component({ selector: 'app-accessibility-widget', template: '' })
class AccessibilityWidgetStub {}

describe('AppComponent', () => {
  let notifications: jasmine.SpyObj<NotificationsService>;
  let updates: jasmine.SpyObj<UpdateService>;
  let accessibility: jasmine.SpyObj<AccessibilityService>;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationsService>('NotificationsService', ['init']);
    updates = jasmine.createSpyObj<UpdateService>('UpdateService', ['init']);
    accessibility = jasmine.createSpyObj<AccessibilityService>('AccessibilityService', ['init']);

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: NotificationsService, useValue: notifications },
        { provide: UpdateService, useValue: updates },
        { provide: AccessibilityService, useValue: accessibility },
        { provide: PersonalService, useValue: {} },
        { provide: StarredService, useValue: {} },
        { provide: WorkNotificationsService, useValue: {} },
      ],
    })
      .overrideComponent(AppComponent, {
        set: { imports: [RouterOutlet, StaffChatStub, UpdateBannerStub, AccessibilityWidgetStub] },
      })
      .compileComponents();
  });

  it('creates the component', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('starts notifications, updates and accessibility exactly once on init', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges(); // runs ngOnInit
    expect(notifications.init).toHaveBeenCalledTimes(1);
    expect(updates.init).toHaveBeenCalledTimes(1);
    expect(accessibility.init).toHaveBeenCalledTimes(1);
  });

  it('renders the skip link in Hebrew, the router outlet and the child components', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const link = el.querySelector<HTMLAnchorElement>('a.skip-link');
    expect(link?.textContent?.trim()).toBe('דלג לתוכן הראשי');
    expect(link?.getAttribute('href')).toBe('#main-content');
    expect(el.querySelector('router-outlet')).toBeTruthy();
    expect(el.querySelector('app-update-banner')).toBeTruthy();
    expect(el.querySelector('app-accessibility-widget')).toBeTruthy();
    expect(el.querySelector('app-staff-chat')).toBeTruthy();
  });

  it('skip link moves the focus to the main content and prevents the default jump', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const main = document.createElement('main');
    main.id = 'main-content';
    document.body.appendChild(main);
    try {
      const event = new Event('click', { cancelable: true });
      fixture.componentInstance.skipToContent(event);
      expect(event.defaultPrevented).toBeTrue();
      expect(main.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(main);
    } finally {
      main.remove();
    }
  });

  it('skip link does nothing and does not throw when there is no main element', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const event = new Event('click', { cancelable: true });
    expect(() => fixture.componentInstance.skipToContent(event)).not.toThrow();
    expect(event.defaultPrevented).toBeTrue();
  });
});
