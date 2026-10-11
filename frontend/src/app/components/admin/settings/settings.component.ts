import { Component, OnInit } from '@angular/core';
import { AdminService } from '../../../services/admin.service';
import { NbButtonModule, NbCardModule, NbToastrService, NbIconModule, NbInputModule } from "@nebular/theme";

import { FormsModule } from '@angular/forms';
import { Setting } from '../../../models/setting.model';

@Component({
  selector: 'app-settings',
  imports: [
    NbCardModule,
    NbButtonModule,
    NbIconModule,
    NbInputModule,
    FormsModule
],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {

  settings: Setting[] = [];
  setInProgress: boolean = false;

  readonly moderationLevels = [
    { value: 'strict', label: 'מחמיר: כל דמות שלא זוהתה בוודאות כגבר מטושטשת' },
    { value: 'normal', label: 'רגיל: ספים מתונים יותר, טעות בודדת של המודל לא מטשטשת' },
    { value: 'lenient', label: 'מקל: דמויות קטנות ורחוקות בלי פנים נשארות גלויות' },
  ];

  get moderationLevel(): string {
    return this.settings.find(s => s.key === 'moderation_level')?.value || 'strict';
  }

  setModerationLevel(value: string) {
    const setting = this.settings.find(s => s.key === 'moderation_level');
    if (setting) {
      setting.value = value;
    } else {
      this.settings.push({ key: 'moderation_level', value });
    }
  }

  constructor(
    private adminService: AdminService,
    private tostService: NbToastrService,
  ) { }

  ngOnInit(): void {
    this.adminService.getSettings()
      .then(settings => this.settings = settings || []);
  }

  saveSettings() {
    this.setInProgress = true;
    this.adminService.setSettings(this.settings)
      .then(() => this.tostService.success('', 'השינוים נשמרו בהצלחה!'))
      .catch(() => this.tostService.danger('', 'שגיאה בשמירת השינוים'));
    this.setInProgress = false;
  }

  removeSetting(index: number) {
    // if (!confirm('האם אתה בטוח שברצונך למחוק את ההגדרה הזו?')) return;
    this.settings.splice(index, 1);
  }
}
